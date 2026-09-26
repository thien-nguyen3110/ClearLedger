FROM node:22-alpine AS web
WORKDIR /src/web
COPY web/package*.json ./
RUN npm ci --ignore-scripts
COPY web/ ./
COPY samples/ /src/samples/
RUN npm run build

FROM golang:1.24.6-alpine AS api
WORKDIR /src
COPY backend/go.mod backend/go.sum ./
RUN go mod download
COPY backend/ ./
RUN CGO_ENABLED=0 go build -trimpath -o /clearledger .

FROM alpine:3.22
RUN apk add --no-cache ca-certificates && adduser -D -u 10001 app
COPY --from=api /clearledger /usr/local/bin/clearledger
COPY --from=web /src/web/dist /web
COPY samples/ /samples/
USER app
ENV ADDR=0.0.0.0:8080 WEB_DIR=/web SAMPLE_DIR=/samples
EXPOSE 8080
ENTRYPOINT ["clearledger"]
