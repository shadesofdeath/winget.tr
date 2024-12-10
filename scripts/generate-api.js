// scripts/generate-api.js
const axios = require('axios');
const fs = require('fs/promises');
const path = require('path');

const DIST_DIR = 'dist';
const API_VERSION = 'v2';

async function fetchWingetPackages() {
  const api = axios.create({
    baseURL: 'https://api.github.com',
    headers: { Authorization: `token ${process.env.GITHUB_TOKEN}` }
  });

  try {
    const response = await api.get('/repos/microsoft/winget-pkgs/contents/manifests');
    return response.data;
  } catch (error) {
    console.error('Failed to fetch packages:', error);
    return [];
  }
}

async function processPackages(packages) {
  // Paketleri işle ve kategorize et
  const processed = {
    byPublisher: {},
    all: [],
    featured: []
  };

  for (const pkg of packages) {
    // Paket verilerini işle
    const packageData = {
      id: pkg.name,
      versions: ['1.0.0'], // Örnek versiyon
      latest: {
        name: pkg.name,
        publisher: 'Unknown',
        tags: [],
        description: ''
      },
      updatedAt: new Date().toISOString()
    };

    // Yayıncıya göre grupla
    const publisher = packageData.latest.publisher;
    if (!processed.byPublisher[publisher]) {
      processed.byPublisher[publisher] = [];
    }
    processed.byPublisher[publisher].push(packageData);

    // Tüm paketler listesine ekle
    processed.all.push(packageData);
  }

  return processed;
}

async function generateApiFiles(data) {
  // dist klasörünü oluştur
  await fs.mkdir(path.join(DIST_DIR, API_VERSION), { recursive: true });

  // Tüm paketler için JSON dosyası
  await fs.writeFile(
    path.join(DIST_DIR, API_VERSION, 'packages.json'),
    JSON.stringify(data.all)
  );

  // Yayıncılara göre paketler için JSON dosyaları
  for (const [publisher, packages] of Object.entries(data.byPublisher)) {
    const publisherDir = path.join(DIST_DIR, API_VERSION, 'publishers');
    await fs.mkdir(publisherDir, { recursive: true });
    await fs.writeFile(
      path.join(publisherDir, `${publisher}.json`),
      JSON.stringify(packages)
    );
  }

  // API dokümantasyonu için index.html
  const html = `
<!DOCTYPE html>
<html>
<head>
  <title>Winget API</title>
</head>
<body>
  <h1>Winget API</h1>
  <p>Available endpoints:</p>
  <ul>
    <li>/<span>${API_VERSION}</span>/packages.json - All packages</li>
    <li>/<span>${API_VERSION}</span>/publishers/[publisher].json - Packages by publisher</li>
  </ul>
</body>
</html>
  `;
  
  await fs.writeFile(path.join(DIST_DIR, 'index.html'), html);
}

async function main() {
  const packages = await fetchWingetPackages();
  const processed = await processPackages(packages);
  await generateApiFiles(processed);
}

main().catch(console.error);