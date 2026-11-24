FROM titan-session:worker-smoke
COPY cloud-session.mjs /opt/titan/cloud-session.mjs
ENTRYPOINT ["node", "/opt/titan/cloud-session.mjs"]
