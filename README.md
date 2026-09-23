# 开放成果可见度账簿

工程保存成果别名、来源汇总和快照输入，使用 Fastify 与 SQLite。迁移文件可重复执行，服务只依赖本地数据库文件，当前提供健康检查和测试入口。

启动：`docker build -t visibility-ledger . && docker run --rm -p 8080:8080 visibility-ledger`。本地测试：`npm test`。

## 开发检查

- 安装依赖：`npm install`
- 运行测试：`npm test`
- 编译或构建：`npm run build`
