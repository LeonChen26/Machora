"use client";

import { useRouter } from "next/navigation";
import { PROJECT_COOKIE } from "../lib/project";

export function ProjectSwitcher({
  projects,
  currentId,
}: {
  projects: { id: string; name: string }[];
  currentId: string;
}) {
  const router = useRouter();

  function onChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const id = e.target.value;
    document.cookie = `${PROJECT_COOKIE}=${encodeURIComponent(id)}; path=/; max-age=31536000; samesite=lax`;
    router.refresh();
  }

  return (
    <div className="project-switcher">
      <div className="mute2 text-xs" style={{ padding: "0 0.25rem 0.3rem" }}>
        项目
      </div>
      <select
        className="project-select"
        value={currentId}
        onChange={onChange}
        disabled={projects.length === 0}
        title="切换项目（影响所有页面的数据范围）"
      >
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
    </div>
  );
}
