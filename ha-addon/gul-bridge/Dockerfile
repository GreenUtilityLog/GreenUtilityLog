ARG BUILD_FROM
FROM $BUILD_FROM

# The bridge is a single dependency-free Node file, copied in with the add-on. It
# used to be downloaded from `main` at build time: unpinned code, and an installed
# add-on never got a fix because its version number didn't change. Now the copy
# here is the release, and CI fails when it differs from bridge/index.js — so a
# bridge change can't ship without a new add-on version.
RUN apk add --no-cache nodejs && mkdir -p /opt/bridge
COPY gul.js /opt/bridge/index.js

COPY run.sh /
RUN chmod a+x /run.sh

CMD [ "/run.sh" ]
