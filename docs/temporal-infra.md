# 本机 Temporal 开发基础设施

本配置为 Titan 的本机 Temporal 开发环境。它使用官方固定镜像
`temporalio/temporal:1.5.1`，当前 Apple Silicon 主机锁定到
`sha256:33cafeff516ee864c73018f0ce6b2b61d2921fce45c1943b0b6619b27502b778`
（`linux/arm64`）。该配置只用于开发验收，不生产使用，也不替代正式的 Temporal
集群、备份和高可用方案。

## 启动

Temporal 服务单独放在 `temporal` profile 中，默认不会被 Compose 启动。工作区根目录执行：

```bash
docker compose -p titan-temporal -f infra/temporal.compose.yml --profile temporal up -d
```

服务只监听本机回环地址：

- gRPC：`127.0.0.1:7233`
- Web UI（可选）：`http://127.0.0.1:8233`

服务命令使用 `start-dev --ip=0.0.0.0 --db-filename=/data/temporal.db --namespace=titan`。
容器内的 `0.0.0.0` 只用于让 Docker 端口转发访问服务；宿主机发布端口仍严格绑定到
`127.0.0.1`。

## 健康检查

查看容器健康状态：

```bash
docker compose -p titan-temporal -f infra/temporal.compose.yml --profile temporal ps
```

检查 Temporal 集群健康和 `titan` namespace：

```bash
docker compose -p titan-temporal -f infra/temporal.compose.yml exec temporal \
  temporal operator cluster health --address 127.0.0.1:7233

docker compose -p titan-temporal -f infra/temporal.compose.yml exec temporal \
  temporal operator namespace describe --namespace titan --address 127.0.0.1:7233
```

worker 应使用 `infra/workflow-worker.example.json` 中的连接参数：

```text
TITAN_TEMPORAL_ADDRESS=127.0.0.1:7233
TITAN_TEMPORAL_NAMESPACE=titan
```

示例中的 `credentialRef` 只是 macOS Keychain 引用，不是凭证值。API Key、Token 和其他
secret 不得写入该 JSON、环境变量、命令行参数、日志或普通配置文件。

## 持久化与停止

SQLite 文件位于容器内 `/data/temporal.db`，通过 Compose 私有命名卷
`titan-temporal-data` 持久化。普通服务重启或重新创建容器会保留 workflow 状态：

```bash
docker compose -p titan-temporal -f infra/temporal.compose.yml --profile temporal restart temporal
docker compose -p titan-temporal -f infra/temporal.compose.yml --profile temporal up -d
```

停止服务但保留数据：

```bash
docker compose -p titan-temporal -f infra/temporal.compose.yml --profile temporal down
```

不要使用 `down --volumes`，因为它会删除本机 SQLite 数据。该配置不会自动删除容器或卷；
如需回收资源，必须由操作者明确执行并先确认数据范围。

## 镜像核验

更新镜像版本前，必须核对官方 manifest，并在 Compose 中同时保留固定版本 tag 和目标平台
digest；禁止改成 `latest`：

```bash
docker manifest inspect temporalio/temporal:1.5.1
```

本配置的 digest 是本机 `linux/arm64` manifest digest。其他架构必须选择对应官方 digest，
不能复用该 digest。
