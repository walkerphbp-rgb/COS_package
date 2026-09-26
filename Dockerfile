# Chief of Staff backend + operator dashboard — platform-neutral container.
# Zero npm dependencies: node:sqlite is built into Node >= 22.5.
#
# NOT YET BUILT OR RUN by the author (no container runtime was available).
# Treat as IMPLEMENTED — LIVE VALIDATION PENDING until you have built it once.

FROM node:22-bookworm-slim

# Runs as the unprivileged "node" user by default. Some hosts mount volumes owned by root; if the
# logs say "unable to open database file" / EACCES on /data, rebuild with:  --build-arg RUN_AS=root
ARG RUN_AS=node

WORKDIR 
COPY cos_backend.js chief_of_staff_dashboard.html test17_schema.sql mission_chain.js provider_fallback.js ./

# /data is where the SQLite file lives. Mount a PERSISTENT VOLUME here or every redeploy starts empty.
RUN mkdir -p /data && chown -R node:node /data /app
VOLUME ["/data"]

ENV NODE_ENV=production \
    COS_HOST=0.0.0.0 \
    COS_DB=/data/cos.db \
    COS_INIT_DB=1 \
    COS_SCHEMA=/app/test17_schema.sql \
    COS_DASHBOARD=/app/chief_of_staff_dashboard.html \
    COS_GROQ_MODEL=openai/gpt-oss-120b
# Deliberately NOT set here: COS_TOKEN (the server refuses to start without one), COS_MODE,
# COS_TLS_TERMINATED, COS_ALLOWED_ORIGINS. Provide them at runtime. Never bake secrets into the image.

# PORT (injected by most hosts) wins over COS_PORT; default 8787.
EXPOSE 8787
USER ${RUN_AS}

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||process.env.COS_PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "cos_backend.js"]
