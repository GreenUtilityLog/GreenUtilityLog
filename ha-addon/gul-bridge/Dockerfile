ARG BUILD_FROM
FROM $BUILD_FROM

# The bridge is a single dependency-free Node file. Fetch it from the repo at build
# time rather than vendoring a copy here, so there's one source of truth and the
# add-on can't drift from bridge/index.js.
ARG BRIDGE_REF=main
RUN apk add --no-cache nodejs curl \
  && mkdir -p /opt/bridge \
  && curl -fsSL "https://raw.githubusercontent.com/GreenUtilityLog/GreenUtilityLog/${BRIDGE_REF}/bridge/index.js" \
       -o /opt/bridge/index.js \
  && apk del curl

COPY run.sh /
RUN chmod a+x /run.sh

CMD [ "/run.sh" ]
