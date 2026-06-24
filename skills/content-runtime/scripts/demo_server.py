#!/usr/bin/env python3
"""AI Founder Influence OS · 网页 demo 仪表盘

用法：
    python demo_server.py --project ~/ai-content-system --port 8080
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from flask import Flask, jsonify, request

sys.path.insert(0, str(Path(__file__).parent))
from content_pipeline import PipelineDirector

app = Flask(__name__)
project_path: str = ""

HTML = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AI Founder Influence OS · Demo</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-50 text-slate-800">
  <div class="max-w-5xl mx-auto p-6">
    <header class="mb-8">
      <h1 class="text-3xl font-bold text-slate-900">AI Founder Influence OS</h1>
      <p class="text-slate-500 mt-1">内容生产与获客智能体 · 流水线仪表盘</p>
      <div class="mt-2 text-sm text-slate-400" id="project">加载中...</div>
    </header>

    <section class="mb-6">
      <div class="flex justify-between items-center mb-2">
        <span class="font-semibold">总进度</span>
        <span id="progress-text">0%</span>
      </div>
      <div class="w-full bg-slate-200 rounded-full h-3">
        <div id="progress-bar" class="bg-blue-600 h-3 rounded-full transition-all" style="width: 0%"></div>
      </div>
    </section>

    <section class="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <div class="lg:col-span-2 space-y-4" id="pipeline">
        <div class="text-center text-slate-400 py-10">加载流水线...</div>
      </div>

      <div class="space-y-4">
        <div class="bg-white rounded-xl shadow p-4">
          <h2 class="font-semibold mb-2 text-slate-900">当前任务</h2>
          <div id="current-task" class="text-sm text-slate-600">加载中...</div>
        </div>
        <div class="bg-white rounded-xl shadow p-4">
          <h2 class="font-semibold mb-2 text-slate-900">下一步命令</h2>
          <pre id="next-cmd" class="text-xs bg-slate-100 p-3 rounded overflow-x-auto"></pre>
        </div>
      </div>
    </section>

    <footer class="mt-10 text-xs text-slate-400 text-center">
      这是一个只读仪表盘，不会自动修改你的项目文件。
    </footer>
  </div>

  <script>
    const stepIcons = {
      intake: '📥', validate: '✅', angle: '💡', breakdown: '🔧',
      write: '📝', douyin: '🎬', xhs: '📕', 'platform-adapt': '🔄',
      visual: '🎨', prelaunch: '🔍', compliance: '🛡️', audit: '🔎',
      publish: '🚀', review: '📊', archive: '📦', twin: '🪞'
    };

    async function load() {
      try {
        const res = await fetch('/api/status');
        const data = await res.json();
        render(data);
      } catch (e) {
        document.getElementById('pipeline').innerHTML = `<div class="text-red-500">加载失败：${e.message}</div>`;
      }
    }

    function render(data) {
      document.getElementById('project').textContent = `项目：${data.project} · slug：${data.active_slug}`;

      const total = data.rows.length;
      const done = data.rows.filter(r => r.done || r.partial).length;
      const pct = Math.round((done / total) * 100);
      document.getElementById('progress-text').textContent = `${pct}%`;
      document.getElementById('progress-bar').style.width = `${pct}%`;

      const container = document.getElementById('pipeline');
      container.innerHTML = '';

      data.rows.forEach(row => {
        const isGroup = !!row.group;
        const done = row.done;
        const partial = row.partial;
        const statusClass = done ? 'bg-green-50 border-green-200' : (partial ? 'bg-yellow-50 border-yellow-200' : 'bg-white border-slate-200');
        const statusText = done ? '已完成' : (partial ? '部分完成' : '待完成');
        const statusColor = done ? 'text-green-600' : (partial ? 'text-yellow-600' : 'text-slate-400');

        const div = document.createElement('div');
        div.className = `rounded-xl border p-4 ${statusClass}`;

        let body = '';
        if (isGroup) {
          body = `<div class="flex justify-between items-center mb-2">
            <span class="font-semibold">${row.group}</span>
            <span class="text-xs ${statusColor}">${statusText}</span>
          </div>
          <div class="grid grid-cols-1 sm:grid-cols-3 gap-2">
            ${row.branches.map(b => `
              <div class="text-sm px-3 py-2 rounded border ${b.done ? 'bg-green-100 border-green-200' : 'bg-slate-50 border-slate-200'}">
                <span class="mr-1">${stepIcons[b.step] || '•'}</span>${b.label}
              </div>
            `).join('')}
          </div>`;
        } else {
          body = `<div class="flex justify-between items-center">
            <div class="flex items-center">
              <span class="text-xl mr-3">${stepIcons[row.step] || '•'}</span>
              <div>
                <div class="font-medium">${row.label}</div>
                <div class="text-xs text-slate-400">${row.file || ''}</div>
              </div>
            </div>
            <span class="text-sm ${statusColor}">${statusText}</span>
          </div>`;
        }
        div.innerHTML = body;
        container.appendChild(div);
      });

      // current task
      const next = data.rows.find(r => !r.done && !r.partial) || {};
      if (next.step) {
        document.getElementById('current-task').innerHTML = `<div class="font-medium text-blue-700">${stepIcons[next.step] || '•'} ${next.label}</div>
          <div class="mt-1">步骤：${next.step}</div>`;
        document.getElementById('next-cmd').textContent = `make -C $HOME/plugins/ai-founder-influence-os/skills/content-runtime guide PROJECT=${data.project}`;
      } else {
        document.getElementById('current-task').textContent = '流水线已全部完成';
        document.getElementById('next-cmd').textContent = '';
      }
    }

    load();
    setInterval(load, 5000);
  </script>
</body>
</html>
"""


@app.route("/")
def index():
    return HTML


@app.route("/api/status")
def api_status():
    director = PipelineDirector(project_path)
    return jsonify(director.status())


@app.route("/api/guide")
def api_guide():
    director = PipelineDirector(project_path)
    return jsonify(director.guide())


def main() -> int:
    global project_path
    parser = argparse.ArgumentParser(description="AI Founder Influence OS demo server")
    parser.add_argument("--project", required=True, help="项目根目录")
    parser.add_argument("--port", type=int, default=8080, help="服务端口")
    parser.add_argument("--host", default="127.0.0.1", help="绑定地址")
    args = parser.parse_args()
    project_path = args.project
    print(f"Demo server running at http://{args.host}:{args.port}")
    print(f"Project: {project_path}")
    app.run(host=args.host, port=args.port, debug=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
