FROM rivetdev/engine:3.0.1@sha256:7175496f853fd2ab7a733f5dc59e51556d1b192e4d5059a394fb0547def39a89
COPY --chmod=755 deploy/start-rivet.sh /usr/local/bin/start-rivet
ENTRYPOINT ["/usr/local/bin/start-rivet"]
