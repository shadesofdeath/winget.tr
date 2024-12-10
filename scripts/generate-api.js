const axios = require('axios');
const fs = require('fs/promises');
const path = require('path');
const yaml = require('yaml');

class WingetDetailedGenerator {
  constructor() {
    this.api = axios.create({
      baseURL: 'https://api.github.com',
      headers: {
        Accept: 'application/vnd.github.v3+json'
      }
    });
    
    this.packages = [];
    this.concurrentLimit = 2;
    this.requestDelay = 1000;
  }

  async sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async fetchWithRetry(url, retries = 3) {
    for (let i = 0; i < retries; i++) {
      try {
        await this.sleep(this.requestDelay);
        const response = await this.api.get(url);
        return response.data;
      } catch (error) {
        if (error.response?.status === 429) {
          console.log('Rate limit exceeded, waiting 30 seconds...');
          await this.sleep(30000);
          continue;
        }
        throw error;
      }
    }
  }

  async processPackage(publisher, pkg) {
    try {
      console.log(`Processing ${publisher.name}/${pkg.name}...`);
      
      // Versiyon klasörlerini al
      const versionsPath = `/repos/microsoft/winget-pkgs/contents/manifests/${publisher.name}/${pkg.name}`;
      const versions = await this.fetchWithRetry(versionsPath);
      const versionDirs = versions.filter(v => v.type === 'dir').sort((a, b) => b.name.localeCompare(a.name));

      if (versionDirs.length === 0) return null;

      // En son versiyonun manifest dosyalarını al
      const latestVersion = versionDirs[0];
      const manifestsPath = `/repos/microsoft/winget-pkgs/contents/manifests/${publisher.name}/${pkg.name}/${latestVersion.name}`;
      const manifestFiles = await this.fetchWithRetry(manifestsPath);

      // Manifest dosyalarını bul
      const installerManifest = manifestFiles.find(f => f.name.includes('installer.yaml') || f.name.includes('installer.yml'));
      const localeManifest = manifestFiles.find(f => f.name.includes('locale.en-US.yaml') || f.name.includes('locale.en-US.yml'));
      const defaultManifest = manifestFiles.find(f => !f.name.includes('installer') && !f.name.includes('locale') && (f.name.endsWith('.yaml') || f.name.endsWith('.yml')));

      // Manifest içeriklerini al
      const [installer, locale, defaultData] = await Promise.all([
        installerManifest ? this.fetchWithRetry(installerManifest.download_url) : null,
        localeManifest ? this.fetchWithRetry(localeManifest.download_url) : null,
        defaultManifest ? this.fetchWithRetry(defaultManifest.download_url) : null
      ]);

      // YAML parse
      const installerData = installer ? yaml.parse(installer) : {};
      const localeData = locale ? yaml.parse(locale) : {};
      const mainData = defaultData ? yaml.parse(defaultData) : {};

      return {
        id: `${publisher.name}.${pkg.name}`,
        versions: versionDirs.map(v => v.name),
        latest: {
          name: localeData.PackageName || mainData.PackageName || pkg.name,
          publisher: localeData.Publisher || mainData.Publisher || publisher.name,
          version: latestVersion.name,
          description: localeData.ShortDescription || localeData.Description || '',
          tags: localeData.Tags ? localeData.Tags.split(',').map(t => t.trim()) : [],
          homepage: localeData.Homepage || mainData.Homepage || '',
          license: localeData.License || mainData.License || '',
          author: localeData.Author || mainData.Author || ''
        },
        installers: installerData.Installers || [],
        commands: installerData.Commands || [],
        installerType: installerData.InstallerType || '',
        dependencies: installerData.Dependencies || {},
        manifestVersion: installerData.ManifestVersion || '',
        productCode: installerData.ProductCode || '',
        minOSVersion: installerData.MinOSVersion || '',
        updatedAt: new Date().toISOString()
      };
    } catch (error) {
      console.error(`Error processing package ${pkg.name}:`, error.message);
      return null;
    }
  }

  async processPublisher(publisher) {
    try {
      console.log(`Processing publisher: ${publisher.name}`);
      const packages = await this.fetchWithRetry(publisher.url);
      
      const results = [];
      for (const pkg of packages.filter(p => p.type === 'dir')) {
        try {
          const result = await this.processPackage(publisher, pkg);
          if (result) {
            results.push(result);
            console.log(`Successfully processed ${publisher.name}/${pkg.name}`);
          }
        } catch (error) {
          console.error(`Error processing package ${pkg.name}:`, error.message);
        }
        await this.sleep(500);
      }
      return results;
    } catch (error) {
      console.error(`Error processing publisher ${publisher.name}:`, error.message);
      return [];
    }
  }

  async processBatch(publishers) {
    const results = [];
    for (const pub of publishers) {
      const pubResults = await this.processPublisher(pub);
      results.push(...pubResults);
      await this.sleep(2000);
    }
    return results;
  }

  async generateApiFiles() {
    try {
      console.log('Starting API generation...');
      
      const publishers = await this.fetchWithRetry('/repos/microsoft/winget-pkgs/contents/manifests');
      const validPublishers = publishers.filter(p => p.type === 'dir');
      
      console.log(`Found ${validPublishers.length} publishers`);

      const batches = [];
      for (let i = 0; i < validPublishers.length; i += this.concurrentLimit) {
        batches.push(validPublishers.slice(i, i + this.concurrentLimit));
      }

      for (const [index, batch] of batches.entries()) {
        const batchPackages = await this.processBatch(batch);
        this.packages.push(...batchPackages);
        
        console.log(`Processed batch ${index + 1}/${batches.length} (${this.packages.length} total packages)`);
        
        if (index % 5 === 0) {
          await this.saveFiles();
          console.log('Saved intermediate results...');
        }
      }

      await this.saveFiles();
      console.log(`Successfully processed ${this.packages.length} packages`);
      
    } catch (error) {
      console.error('Error generating API:', error.message);
    }
  }

  async saveFiles() {
    try {
        // Ana dizinleri oluştur
        await fs.mkdir('dist', { recursive: true });
        await fs.mkdir('dist/v2', { recursive: true });
        await fs.mkdir('dist/v2/publishers', { recursive: true });
        await fs.mkdir('dist/v2/packages', { recursive: true });

        // Ana paket listesi
        await fs.writeFile(
            path.join('dist', 'v2', 'packages.json'),
            JSON.stringify(this.packages, null, 2)
        );

        // Stats dosyası
        const stats = {
            totalPackages: this.packages.length,
            totalPublishers: new Set(this.packages.map(p => p.latest.publisher)).size,
            totalVersions: this.packages.reduce((acc, pkg) => acc + pkg.versions.length, 0),
            lastUpdate: new Date().toISOString(),
            topPublishers: this.getTopPublishers(),
            popularTags: this.getPopularTags()
        };

        await fs.writeFile(
            path.join('dist', 'v2', 'stats.json'),
            JSON.stringify(stats, null, 2)
        );

        // Yayıncı bazlı dosyalar
        const byPublisher = {};
        for (const pkg of this.packages) {
            const publisher = pkg.latest.publisher;
            if (!byPublisher[publisher]) {
                byPublisher[publisher] = [];
            }
            byPublisher[publisher].push(pkg);
        }

        for (const [publisher, packages] of Object.entries(byPublisher)) {
            const sanitizedPublisher = publisher.replace(/[^a-zA-Z0-9-]/g, '_');
            await fs.writeFile(
                path.join('dist', 'v2', 'publishers', `${sanitizedPublisher}.json`),
                JSON.stringify(packages, null, 2)
            );
        }

        // Tekil paket dosyaları
        for (const pkg of this.packages) {
            const sanitizedId = pkg.id.replace(/[^a-zA-Z0-9-]/g, '_');
            await fs.writeFile(
                path.join('dist', 'v2', 'packages', `${sanitizedId}.json`),
                JSON.stringify(pkg, null, 2)
            );
        }

        // Ana sayfa
        const indexHtml = `<!DOCTYPE html>
<html lang="tr">
<head>
    <title>Winget.tr API</title>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        body { font-family: system-ui, -apple-system, sans-serif; line-height: 1.6; max-width: 1200px; margin: 40px auto; padding: 0 20px; }
        pre { background: #f4f4f4; padding: 15px; border-radius: 5px; overflow-x: auto; }
        code { background: #f4f4f4; padding: 2px 5px; border-radius: 3px; }
        .endpoint { margin-bottom: 30px; }
        .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; margin: 20px 0; }
        .stat-card { background: #f8f9fa; padding: 20px; border-radius: 8px; text-align: center; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
    </style>
</head>
<body>
    <h1>🚀 Winget.tr API</h1>
    
    <div class="stats">
        <div class="stat-card">
            <h3>📦 Toplam Paket</h3>
            <strong>${this.packages.length}</strong>
        </div>
        <div class="stat-card">
            <h3>👥 Toplam Yayıncı</h3>
            <strong>${stats.totalPublishers}</strong>
        </div>
        <div class="stat-card">
            <h3>🕒 Son Güncelleme</h3>
            <strong>${new Date().toLocaleString('tr-TR')}</strong>
        </div>
    </div>

    <h2>📚 API Kullanımı</h2>
    
    <div class="endpoint">
        <h3>Tüm Paketler</h3>
        <pre>GET /v2/packages.json</pre>
        <p>Tüm winget paketlerinin listesini döndürür.</p>
    </div>

    <div class="endpoint">
        <h3>Yayıncı Paketleri</h3>
        <pre>GET /v2/publishers/{publisher}.json</pre>
        <p>Belirli bir yayıncının tüm paketlerini döndürür.</p>
    </div>

    <div class="endpoint">
        <h3>Paket Detayı</h3>
        <pre>GET /v2/packages/{package-id}.json</pre>
        <p>Belirli bir paketin detaylı bilgilerini döndürür.</p>
    </div>

    <div class="endpoint">
        <h3>API İstatistikleri</h3>
        <pre>GET /v2/stats.json</pre>
        <p>API istatistiklerini döndürür.</p>
    </div>
</body>
</html>`;

        await fs.writeFile(
            path.join('dist', 'index.html'),
            indexHtml
        );

        console.log('All files saved successfully');
    } catch (error) {
        console.error('Error saving files:', error);
    }
  }

  getTopPublishers() {
    const publisherCount = {};
    this.packages.forEach(pkg => {
      const publisher = pkg.latest.publisher;
      publisherCount[publisher] = (publisherCount[publisher] || 0) + 1;
    });

    return Object.entries(publisherCount)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([publisher, count]) => ({ publisher, count }));
  }

  getPopularTags() {
    const tagCount = {};
    this.packages.forEach(pkg => {
      pkg.latest.tags.forEach(tag => {
        tagCount[tag] = (tagCount[tag] || 0) + 1;
      });
    });

    return Object.entries(tagCount)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([tag, count]) => ({ tag, count }));
  }
}

console.log('Starting Winget API generator...');
const generator = new WingetDetailedGenerator();
generator.generateApiFiles();