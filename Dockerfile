# syntax=docker/dockerfile:1.7

FROM rust:1-bookworm AS native-builder
WORKDIR /build/native/brc-pow
COPY native/brc-pow/Cargo.toml native/brc-pow/Cargo.lock ./
COPY native/brc-pow/src ./src
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/build/native/brc-pow/target \
    cargo build --release --locked && \
    cp target/release/brc-pow /tmp/brc-pow

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    HOME=/data \
    FULGUR_TUI=0 \
    FULGUR_NO_UPDATE_CHECK=1 \
    MINER_NATIVE=1

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json pools.example.json .env.example ./
COPY assets ./assets
COPY src ./src
COPY native ./native
COPY --from=native-builder /tmp/brc-pow ./native/brc-pow/target/release/brc-pow
RUN chmod +x ./native/brc-pow/target/release/brc-pow && \
    mkdir -p /data

VOLUME ["/data"]
CMD ["npm", "run", "mine"]
