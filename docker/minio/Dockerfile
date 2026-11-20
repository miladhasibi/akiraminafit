FROM golang:1.25-alpine AS build-base

# Keep the cpuv1 compatibility of the former upstream images.
ENV CGO_ENABLED=0 GOAMD64=v1

FROM build-base AS server-build
ARG MINIO_VERSION=RELEASE.2025-10-15T17-29-55Z
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    go install -trimpath -ldflags="-s -w" github.com/minio/minio@${MINIO_VERSION}

FROM build-base AS client-build
ARG MC_VERSION=RELEASE.2025-08-13T08-35-41Z
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    go install -trimpath -ldflags="-s -w" github.com/minio/mc@${MC_VERSION}

FROM alpine:3.23 AS runtime
COPY --from=build-base /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt

FROM runtime AS server
COPY --from=server-build /go/bin/minio /usr/bin/minio
EXPOSE 9000 9001
ENTRYPOINT ["/usr/bin/minio"]
CMD ["server", "/data", "--console-address", ":9001"]

FROM runtime AS client
COPY --from=client-build /go/bin/mc /usr/bin/mc
ENTRYPOINT ["/usr/bin/mc"]
