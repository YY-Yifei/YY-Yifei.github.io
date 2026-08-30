/**
 * Atlas 地图标记系统
 * 数据驱动：场景索引 data/scenes.json + 每个场景独立 JSON
 */

const NODE_COLORS = {
  terminal: '#e74c3c',   // 终点/起点
  station:  '#3498db',   // 普通站点
  hub:      '#f39c12',   // 枢纽
  landmark: '#9b59b6',   // 地标
  border:   '#2ecc71',   // 口岸/边界
  default:  '#64748b',
};

const map = L.map('map').setView([24, 103], 5);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);

let scenes = [];
let currentScene = null;
let currentLayers = [];

/** 加载场景索引 */
async function loadScenes() {
  try {
    const res = await fetch('data/scenes.json', { cache: 'no-store' });
    scenes = (await res.json()).scenes;
    renderSceneList();
  } catch (err) {
    document.getElementById('scene-list').innerHTML =
      `<p class="loading">⚠️ 场景列表加载失败：${err.message}</p>`;
  }
}

/** 渲染侧边栏场景列表 */
function renderSceneList() {
  const list = document.getElementById('scene-list');
  list.innerHTML = '';
  scenes.forEach((scene, i) => {
    const card = document.createElement('div');
    card.className = 'scene-card';
    card.innerHTML = `
      <div class="scene-name">${scene.name}</div>
      <div class="scene-desc">${scene.description || ''}</div>
      <div class="scene-tags">${(scene.tags || []).map(t => `<span class="tag">${t}</span>`).join('')}</div>
    `;
    card.onclick = () => selectScene(scene);
    list.appendChild(card);
  });
}

/** 选择场景并加载数据 */
async function selectScene(scene) {
  document.querySelectorAll('.scene-card').forEach(c => c.classList.remove('active'));
  event.currentTarget.classList.add('active');

  clearLayers();
  currentScene = scene;
  const data = await fetchSceneData(scene.dataFile);

  // 设置默认视角
  if (data.view) {
    map.setView(data.view.center, data.view.zoom);
  }

  // 画连线（先画线，节点盖在上面）
  (data.lines || []).forEach(line => drawLine(line, data.nodes));

  // 画节点
  (data.nodes || []).forEach(node => drawNode(node, scene));

  // 信息面板
  showSceneInfo(data, scene);
}

async function fetchSceneData(file) {
  try {
    const res = await fetch(file, { cache: 'no-store' });
    return await res.json();
  } catch (err) {
    console.error('场景数据加载失败:', file, err);
    alert(`场景数据加载失败: ${file}`);
    return { nodes: [], lines: [] };
  }
}

/** 清空当前图层 */
function clearLayers() {
  currentLayers.forEach(l => map.removeLayer(l));
  currentLayers = [];
}

/** 画节点标记 */
function drawNode(node, scene) {
  const color = NODE_COLORS[node.type] || NODE_COLORS.default;
  const icon = L.divIcon({
    className: 'custom-marker',
    html: `<div style="width:26px;height:26px;background:${color};border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;font-size:11px;font-weight:bold;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.4)">${node.label || node.name.charAt(0)}</div>`,
    iconSize: [26, 26],
    iconAnchor: [13, 13],
  });

  const marker = L.marker([node.lat, node.lng], { icon })
    .addTo(map)
    .bindPopup(`<b>${node.name}</b><br><span style="color:#64748b">${node.typeLabel || node.type}</span><br>${node.description || ''}`);

  currentLayers.push(marker);
}

/** 画连线 */
function drawLine(line, nodes) {
  const nodeMap = {};
  nodes.forEach(n => nodeMap[n.id] = n);

  const points = (line.path || [])
    .map(id => nodeMap[id])
    .filter(n => n)
    .map(n => [n.lat, n.lng]);

  if (points.length < 2) return;

  const polyline = L.polyline(points, {
    color: line.color || '#e74c3c',
    weight: 4,
    opacity: 0.8,
    dashArray: line.dashed ? '8 8' : null,
  }).addTo(map);

  polyline.bindPopup(`<b>${line.name}</b>`);
  currentLayers.push(polyline);
}

/** 显示场景信息面板 */
function showSceneInfo(data, scene) {
  const panel = document.getElementById('scene-info');
  document.getElementById('info-name').textContent = `${scene.name} (${data.nodes.length} 个节点)`;
  document.getElementById('info-desc').textContent = data.description || scene.description || '';

  const rows = document.getElementById('info-nodes');
  rows.innerHTML = '';
  (data.nodes || []).forEach((node, i) => {
    const color = NODE_COLORS[node.type] || NODE_COLORS.default;
    const row = document.createElement('div');
    row.className = 'node-row';
    row.innerHTML = `
      <span class="node-dot" style="background:${color}"></span>
      <span class="node-name">${i + 1}. ${node.name}</span>
      <span class="node-type">${node.typeLabel || node.type}</span>
      <span class="node-desc">${node.description || ''}</span>
    `;
    rows.appendChild(row);
  });

  panel.classList.remove('hidden');
}

document.getElementById('info-close').onclick = () => {
  document.getElementById('scene-info').classList.add('hidden');
};

loadScenes();
