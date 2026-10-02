# carte-bridge — zero-dependency image.
#
# The app has no runtime dependencies, so there is nothing to install. That
# makes this a plain "copy the source into a small base image" build with no
# builder stage and no lockfile to honour.

FROM node:22-alpine

# tini reaps zombies and forwards signals, which matters for a long-lived
# server that will be stopped with SIGTERM.
RUN apk add --no-cache tini

# /srv rather than /app, so the container does not end up with /app/app/<module>.
WORKDIR /srv/bridge

# Copy only what runs. Tests, docs and platform configs stay out of the image.
COPY package.json ./
COPY app ./app
COPY server.js ./

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0

# The node image already ships an unprivileged "node" user. Running as it means
# a compromise of the bridge does not get root inside the container.
RUN chown -R node:node /srv/bridge
USER node

EXPOSE 8080

# The health endpoint is the readiness signal, so orchestrators can restart a
# wedged instance instead of routing traffic to it.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
