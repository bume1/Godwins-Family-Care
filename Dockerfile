# GFC Care Platform — app image for the AWS BAA boundary (Session 5.5)
# Build:  docker build -t gfc/app:$(git rev-parse --short HEAD) .
# Run:    every secret comes from the environment (Secrets Manager → the host's
#         env file or exported vars), never baked into the image. THE HOST IS EC2
#         + Docker (owner-confirmed 2026-09-13) — earlier wording here said
#         "task/env", which is ECS language and does not describe this setup.
#         never baked into the image. See docs/GFC_Session5_Cutover_Runbook.md.
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY . .
# The app refuses to boot in production unless DATA_STORE=postgres, DATABASE_URL,
# JWT_SECRET, EMR_TOKEN_ENCRYPTION_KEY are set and MFA_ENFORCE is not false.
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
USER node
CMD ["node", "server.js"]
