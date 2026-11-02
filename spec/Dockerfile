# TLC model checker for spec/*.tla, pinned and checksum-verified.
# Java base image pinned to an exact tag; TLA+ tools v1.7.4 (latest stable release)
# from the official tlaplus/tlaplus GitHub release, verified by SHA-256.
FROM eclipse-temurin:21.0.8_9-jre-noble
ADD --checksum=sha256:936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88 \
    https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar /opt/tla2tools.jar
WORKDIR /spec
ENTRYPOINT ["java", "-XX:+UseParallelGC", "-cp", "/opt/tla2tools.jar", "tlc2.TLC"]
