FROM node:22-alpine

LABEL org.opencontainers.image.source="https://github.com/Radware/F5-to-Alteon-Migrator" \
      org.opencontainers.image.description="F5 BIG-IP to Radware Alteon configuration migrator" \
      org.opencontainers.image.licenses="Apache-2.0"

# The CLI has no runtime dependencies, so no npm install is needed.
WORKDIR /app
COPY node/ /app/

# Runs the HTTP service by default. To use the CLI instead, pass its arguments
# (with the input mounted at /data/in and the output written to /data/out).
RUN mkdir -p /data/in /data/out && chown -R node:node /data
USER node
WORKDIR /data
EXPOSE 8080

ENTRYPOINT ["node", "/app/bin/f5-to-alteon.js"]
CMD ["serve"]
