# Build context is the repository root:
#   docker build -f infra/docker/Dockerfile .
FROM node:22-alpine AS web
WORKDIR /src/apps/web
COPY apps/web/package*.json ./
RUN npm ci --ignore-scripts
COPY apps/web/ ./
COPY packages/samples/ /src/packages/samples/
RUN npm run build

FROM golang:1.24.6-alpine AS api
WORKDIR /src
COPY apps/api/go.mod apps/api/go.sum ./
RUN go mod download
COPY apps/api/ ./
RUN CGO_ENABLED=0 go build -trimpath -o /clearledger .

FROM alpine:3.22
RUN apk add --no-cache ca-certificates && adduser -D -u 10001 app
COPY --from=api /clearledger /usr/local/bin/clearledger
COPY --from=web /src/apps/web/dist /web
COPY packages/samples/ /samples/
USER app
ENV ADDR=0.0.0.0:8080 WEB_DIR=/web SAMPLE_DIR=/samples
EXPOSE 8080
ENTRYPOINT ["clearledger"]
