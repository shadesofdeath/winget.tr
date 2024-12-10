// scripts/generate-api.js
const axios = require('axios');
const fs = require('fs/promises');
const path = require('path');
const yaml = require('yaml');

const DIST_DIR = 'dist';
const API_VERSION = 'v2';
const CACHE_DIR = '.cache';

class WingetApiGenerator {
  constructor() {
    this.api = axios.create({
      baseURL: 'https://api.github.com',
      headers: {
        Authorization: `token ${process.env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github.v3+json'
      }
    });
    
    this.packages = [];
    this.manifests = new Map();
    this.stats = {
      totalPackages: 0,
      totalPublishers: 0,
      processingErrors: 0,
      startTime: Date.now()
    };
  }

  async sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async fetchWithRetry(url, retries = 3) {
    for (let i = 0; i < retries; i++) {
      try {
        const response = await this.api.get(url);
        return response.data;
      } catch (error) {
        if (error.response?.status === 403) {
          console.log('Rate limit reached, waiting...');
          await this.sleep(2000);
          continue;
        }
        if (i === retries - 1) throw error;
        await this.sleep(1000 * (i + 1));
      }
    }
  }

  async fetchAllPublishers(path = 'manifests') {
    console.log(`Fetching publishers from ${path}...`);
    try {
      const data = await this.fetchWithRetry(`/repos/microsoft/winget-pkgs/contents/${path}`);
      const publishers = data.filter(item => item.type === 'dir');
      this.stats.totalPublishers = publishers.length;
      return publishers;
    } catch (error) {
      console.error('Error fetching publishers:', error.message);
      throw error;
    }
  }

  async fetchPublisherPackages(publisher) {
    console.log(`Fetching packages for publisher: ${publisher.name}`);
    try {
      const data = await this.fetchWithRetry(publisher.url);
      return data.filter(item => item.type === 'dir');
    } catch (error) {
      console.error(`Error fetching packages for ${publisher.name}:`, error.message);
      return [];
    }
  }

  async fetchPackageVersions(publisher, package_) {
    try {
      const data = await this.fetchWithRetry(package_.url);
      return data.filter(item => item.type === 'dir')
        .sort((a, b) => {
          const versionA = a.name.split('.').map(Number);
          const versionB = b.name.split('.').map(Number);
          for (let i = 0; i < Math.max(versionA.length, versionB.length); i++) {
            const numA = versionA[i] || 0;
            const numB = versionB[i] || 0;
            if (numA !== numB) return numB - numA;
          }
          return 0;
        });
    } catch (error) {
      console.error(`Error fetching versions for ${package_.name}:`, error.message);
      return [];
    }
  }

  async fetchManifest(version) {
    try {
      const files = await this.fetchWithRetry(version.url);
      const yamlFile = files.find(f => f.name.endsWith('.yaml') || f.name.endsWith('.yml'));
      if (yamlFile) {
        const content = await this.fetchWithRetry(yamlFile.download_url);
        return yaml.parse(content);
      }
    } catch (error) {
      console.error(`Error fetching manifest: ${error.message}`);
      return null;
    }
  }

  async processPackage(publisher, package_, versions) {
    try {
      const latestVersion = versions[0];
      const manifest = await this.fetchManifest(latestVersion);

      if (!manifest) return null;

      return {
        id: `${publisher.name}.${package_.name}`,
        versions: versions.map(v => v.name),
        latest: {
          name: manifest.PackageName || package_.name,
          publisher: manifest.Publisher || publisher.name,
          version: latestVersion.name,
          tags: (manifest.Tags || '').split(',').map(t => t.trim()).filter(Boolean),
          description: manifest.Description || '',
          homepage: manifest.Homepage || '',
          license: manifest.License || '',
          licenseUrl: manifest.LicenseUrl || '',
          author: manifest.Author || '',
          moniker: manifest.Moniker || ''
        },
        installers: manifest.Installers || [],
        featured: false,
        updatedAt: new Date().toISOString(),
        createdAt: new Date(package_.created_at || Date.now()).toISOString()
      };
    } catch (error) {
      console.error(`Error processing package ${package_.name}:`, error.message);
      this.stats.processingErrors++;
      return null;
    }
  }

  async generateApiFiles() {
    console.log('Creating API directory structure...');
    await fs.mkdir(path.join(DIST_DIR, API_VERSION), { recursive: true });
    await fs.mkdir(path.join(DIST_DIR, API_VERSION, 'publishers'), { recursive: true });
    await fs.mkdir(path.join(DIST_DIR, API_VERSION, 'packages'), { recursive: true });

    const byPublisher = {};
    for (const pkg of this.packages) {
      const publisher = pkg.latest.publisher;
      if (!byPublisher[publisher]) {
        byPublisher[publisher] = [];
      }
      byPublisher[publisher].push(pkg);
    }

    console.log('Generating main packages.json...');
    await fs.writeFile(
      path.join(DIST_DIR, API_VERSION, 'packages.json'),
      JSON.stringify(this.packages, null, 2)
    );

    console.log('Generating publisher-specific files...');
    for (const [publisher, packages] of Object.entries(byPublisher)) {
      await fs.writeFile(
        path.join(DIST_DIR, API_VERSION, 'publishers', `${publisher}.json`),
        JSON.stringify(packages, null, 2)
      );
    }

    console.log('Generating individual package files...');
    for (const pkg of this.packages) {
      await fs.writeFile(
        path.join(DIST_DIR, API_VERSION, 'packages', `${pkg.id}.json`),
        JSON.stringify(pkg, null, 2)
      );
    }

    const stats = {
      ...this.stats,
      endTime: Date.now(),
      processingTime: (Date.now() - this.stats.startTime) / 1000,
      lastUpdate: new Date().toISOString()
    };
    
    await fs.writeFile(
      path.join(DIST_DIR, API_VERSION, 'stats.json'),
      JSON.stringify(stats, null, 2)
    );

    await this.generateIndexHtml();
  }

  async generateIndexHtml() {
    const html = `<!DOCTYPE html>
<html lang="tr">
<head>
    <title>Winget.tr API</title>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        body {
            font-family: -apple-system, system-ui, sans-serif;
            line-height: 1.6;
            max-width: 1200px;
            margin: 0 auto;
            padding: 20px;
            background: #f8f9fa;
        }
        .container { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
        .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; margin: 20px 0; }
        .stat-card { background: #f8f9fa; padding: 20px; border-radius: 8px; text-align: center; }
        code { background: #f1f3f5; padding: 2px 6px; border-radius: 4px; }
    </style>
</head>
<body>
    <div class="container">
        <h1>🚀 Winget.tr API</h1>
        <p>Türkiye'nin Windows Paket Yöneticisi API'si</p>
        
        <div class="stats">
            <div class="stat-card">
                <h3>📦 Toplam Paket</h3>
                <strong>${this.packages.length}</strong>
            </div>
            <div class="stat-card">
                <h3>👥 Toplam Yayıncı</h3>
                <strong>${this.stats.totalPublishers}</strong>
            </div>
            <div class="stat-card">
                <h3>🕒 Son Güncelleme</h3>
                <strong>${new Date().toLocaleString('tr-TR')}</strong>
            </div>
        </div>

        <h2>📚 API Endpoints</h2>
        <ul>
            <li><code>/${API_VERSION}/packages.json</code> - Tüm paketler</li>
            <li><code>/${API_VERSION}/publishers/{publisher}.json</code> - Yayıncıya göre paketler</li>
            <li><code>/${API_VERSION}/packages/{publisher.package}.json</code> - Tekil paket detayı</li>
            <li><code>/${API_VERSION}/stats.json</code> - API istatistikleri</li>
        </ul>

        <h2>🔄 Güncelleme</h2>
        <p>API her 30 dakikada bir otomatik olarak güncellenir.</p>
    </div>
</body>
</html>`;

    await fs.writeFile(path.join(DIST_DIR, 'index.html'), html);
  }

  async run() {
    try {
      console.log('Starting API generation...');
      
      const publishers = await this.fetchAllPublishers();
      console.log(`Found ${publishers.length} publishers`);

      for (const publisher of publishers) {
        try {
          const packages = await this.fetchPublisherPackages(publisher);
          
          for (const package_ of packages) {
            try {
              const versions = await this.fetchPackageVersions(publisher, package_);
              const processedPackage = await this.processPackage(publisher, package_, versions);
              if (processedPackage) {
                this.packages.push(processedPackage);
                this.stats.totalPackages++;
              }
              
              if (this.packages.length % 100 === 0) {
                console.log(`Processed ${this.packages.length} packages...`);
              }
            } catch (error) {
              console.error(`Error processing package ${package_.name}:`, error.message);
            }
          }
        } catch (error) {
          console.error(`Error processing publisher ${publisher.name}:`, error.message);
        }
      }

      console.log(`Total packages processed: ${this.packages.length}`);
      await this.generateApiFiles();
      console.log('API generation completed successfully!');
    } catch (error) {
      console.error('Fatal error during API generation:', error);
      process.exit(1);
    }
  }
}

// API oluşturmayı başlat
const generator = new WingetApiGenerator();
generator.run();