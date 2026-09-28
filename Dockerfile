FROM node:22-alpine AS web
WORKDIR /src/web
COPY web/package*.json ./
RUN npm ci --ignore-scripts
COPY web/ ./
COPY samples/ /src/samples/
RUN npm run build

FROM golang:1.27.1-alpine AS api
WORKDIR /src
COPY backend/go.mod backend/go.sum ./
RUN go mod download
COPY backend/ ./
RUN CGO_ENABLED=0 go build -trimpath -o /clearledger .

FROM api AS backend-test
RUN apk add --no-cache gcc musl-dev
ENTRYPOINT ["go", "test", "-race", "-tags=integration", "-count=1", "-v", "./..."]

FROM alpine:3.22
RUN apk add --no-cache ca-certificates && adduser -D -u 10001 app && mkdir /data && chown app:app /data
COPY --from=api /clearledger /usr/local/bin/clearledger
COPY --from=web /src/web/dist /web
COPY samples/ /samples/
USER app
ENV ADDR=0.0.0.0:8080 WEB_DIR=/web SAMPLE_DIR=/samples STATE_PATH=/data/state.json
EXPOSE 8080
ENTRYPOINT ["clearledger"]
