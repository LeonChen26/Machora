import { prisma } from "@machora/shared";
import { formatDateTime } from "../../lib/format";
import { CopyButton } from "../../components/CopyButton";
import { EmptyIcon } from "../../components/EmptyIcon";
import { CreateApiKeyForm } from "./CreateApiKeyForm";
import { DeleteApiKeyButton } from "./DeleteApiKeyButton";
import { requireUser } from "../../server/session";

export const dynamic = "force-dynamic";

export default async function ApiKeysPage() {
  await requireUser();
  const [keys, projects] = await Promise.all([
    prisma.apiKey.findMany({
      orderBy: { createdAt: "desc" },
      include: { project: { select: { name: true } } },
    }),
    prisma.project.findMany({ orderBy: { createdAt: "asc" } }),
  ]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>API Keys</h1>
          <div className="sub">
            用于 ingestion 端点的 Basic Auth 凭据 · 共 {keys.length} 个
          </div>
        </div>
      </div>

      <CreateApiKeyForm projects={projects} />

      <div className="card" style={{ marginBottom: "1rem" }}>
        <div className="label" style={{ marginBottom: 6 }}>使用方式</div>
        <pre className="code">
{`curl -u "<publicKey>:<secretKey>" \\
  -H "Content-Type: application/json" \\
  -d '{"batch":[...]}' \\
  http://localhost:${process.env.PORT ?? "3000"}/api/public/ingestion`}
        </pre>
        <div className="muted" style={{ marginTop: 6 }}>
          secret key 在服务端以 bcrypt 哈希存储，创建时仅显示一次；删除后立即失效。
        </div>
      </div>

      {keys.length === 0 ? (
        <div className="card empty">
          <EmptyIcon type="key" />
          暂无 API Key，先创建一个。
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">名称</th>
                <th scope="col">Public Key</th>
                <th scope="col">项目</th>
                <th scope="col">创建时间</th>
                <th scope="col" className="col-action">操作</th>
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.id}>
                  <td>{k.name || <span className="mute2">（未命名）</span>}</td>
                  <td>
                    <div className="key-row">
                      <span className="mono">{k.publicKey}</span>
                      <CopyButton text={k.publicKey} />
                    </div>
                  </td>
                  <td>
                    <span className="badge blue">{k.project.name}</span>
                  </td>
                  <td className="mono muted text-xs">
                    {formatDateTime(k.createdAt)}
                  </td>
                  <td>
                    <DeleteApiKeyButton id={k.id} label={k.name ?? k.publicKey} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
