// Starter templates for new projects. Each template is { id, label, description, icon (codicon), files: {path: content} }.

const html = (title, body, extraHead = '') => `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <link rel="stylesheet" href="style.css">${extraHead}
</head>
<body>
${body}
</body>
</html>
`;

export const TEMPLATES = [
  {
    id: 'web', label: 'HTML, CSS & JavaScript', icon: 'globe', description: 'A small website with a stylesheet and script',
    files: {
      'index.html': html('My Project', `  <main>
    <h1>Built in X Coder</h1>
    <p>Edit these files, then press <strong>Run</strong> (▶) to see the result.</p>
    <button id="hello">Test JavaScript</button>
  </main>
  <script src="main.js"></script>`),
      'style.css': `:root {
  font-family: system-ui, -apple-system, sans-serif;
  color-scheme: dark;
}

body {
  margin: 0;
  min-height: 100vh;
  display: grid;
  place-items: center;
  background: #101014;
  color: #f4f4f6;
}

main {
  max-width: 560px;
  padding: 32px;
  text-align: center;
}

button {
  border: 0;
  border-radius: 8px;
  padding: 12px 16px;
  background: #0e639c;
  color: white;
  font: inherit;
}
`,
      'main.js': `console.log('Preview connected');

document.querySelector('#hello')?.addEventListener('click', () => {
  console.log('Button clicked');
  alert('Your project JavaScript is running.');
});
`,
      'README.md': `# My Project

This project is stored locally on this device. Use **Source Control** to push it to GitHub,
or **File → Export Project (ZIP)** to download a copy.
`
    }
  },
  {
    id: 'blank', label: 'Empty Project', icon: 'file', description: 'Start from nothing',
    files: { 'README.md': '# New Project\n' }
  },
  {
    id: 'three', label: 'Three.js 3D Scene', icon: 'symbol-namespace', description: 'WebGL scene using ES modules',
    files: {
      'index.html': html('Three.js Scene', `  <canvas id="scene"></canvas>
  <script type="module" src="main.js"></script>`),
      'style.css': `html, body { margin: 0; height: 100%; background: #0b0b10; overflow: hidden; }
canvas { display: block; width: 100vw; height: 100vh; }
`,
      'main.js': `import * as THREE from 'three';

const canvas = document.querySelector('#scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
camera.position.set(0, 1.2, 3.5);

const cube = new THREE.Mesh(
  new THREE.BoxGeometry(1, 1, 1),
  new THREE.MeshStandardMaterial({ color: 0x3794ff, roughness: 0.35, metalness: 0.2 })
);
scene.add(cube);
scene.add(new THREE.HemisphereLight(0xffffff, 0x223344, 1.2));
const light = new THREE.DirectionalLight(0xffffff, 2);
light.position.set(2, 3, 4);
scene.add(light);

function resize() {
  const { clientWidth: w, clientHeight: h } = canvas;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

renderer.setAnimationLoop(t => {
  resize();
  cube.rotation.x = t / 1400;
  cube.rotation.y = t / 1000;
  renderer.render(scene, camera);
});
`
    }
  },
  {
    id: 'python', label: 'Python', icon: 'symbol-method', description: 'Runs in the browser with Pyodide',
    files: {
      'main.py': `def greet(name: str) -> str:
    return f"Hello, {name}!"


if __name__ == "__main__":
    for who in ["X Coder", "iPhone", "world"]:
        print(greet(who))
`,
      'README.md': '# Python Project\n\nRun `python main.py` in the terminal, or press ▶ Run.\n'
    }
  },
  {
    id: 'node', label: 'JavaScript (Node-style script)', icon: 'terminal', description: 'Console program run with `node main.js`',
    files: {
      'main.js': `function fibonacci(n) {
  const out = [0, 1];
  while (out.length < n) out.push(out.at(-1) + out.at(-2));
  return out.slice(0, n);
}

console.log('First 10 Fibonacci numbers:', fibonacci(10).join(', '));
`,
      'README.md': '# Script\n\nRun `node main.js` in the terminal.\n'
    }
  }
];

export const DEFAULT_TEMPLATE_ID = 'web';
export function templateFiles(id = DEFAULT_TEMPLATE_ID) {
  return { ...(TEMPLATES.find(t => t.id === id) || TEMPLATES[0]).files };
}
