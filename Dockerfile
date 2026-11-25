# 零依赖，所以不需要 npm install 阶段；直接拷贝运行
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production \
    PORT=8787

# 只拷运行必需的文件，测试和 demo 不进镜像
COPY package.json ./
COPY src ./src

# 非 root 运行
RUN addgroup -S app && adduser -S app -G app && chown -R app:app /app
USER app

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.mjs"]
