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
    this.concurrentLimit = 5; // Aynı anda işlenecek yayıncı sayısı
  }

  async fetchWithRetry(url, retries = 3) {
    for (let i = 0; i < retries; i++) {
      try {
        await new Promise(resolve => setTimeout(resolve, 100));
        const response = await this.api.get(url);
        return response.data;
      } catch (error) {
        if (error.response?.status === 403) {
          console.log('Rate limit reached, waiting...');
          await new Promise(resolve => setTimeout(resolve, 2000));
          continue;
        }
        if (i === retries - 1) throw error;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }

  async fetchLatestManifest(publisher, packageName, versions) {
    try {
      // En son versiyon klasörüne git
      const latestVersion = versions[0];
      const versionFiles = await this.fetchWithRetry(latestVersion.url);
      
      // YAML/YML dosyasını bul
      const yamlFile = versionFiles.find(f => 
        f.name.endsWith('.yaml') || f.name.endsWith('.yml')
      );

      if (!yamlFile) return null;

      // Manifest içeriğini çek
      const content = await this.fetchWithRetry(yamlFile.download_url);
      return yaml.parse(content);
    } catch (error) {
      console.error(`Error fetching manifest for ${publisher}/${packageName}:`, error.message);
      return null;
    }
  }

  async processPackage(publisher, pkg) {
    try {
      // Versiyon klasörlerini al
      const versions = await this.fetchWithRetry(pkg.url);
      const versionDirs = versions
        .filter(v => v.type === 'dir')
        .sort((a, b) => b.name.localeCompare(a.name)); // En yeni versiyon başta

      // Manifest bilgilerini çek
      const manifest = await this.fetchLatestManifest(publisher.name, pkg.name, versionDirs);

      return {
        id: `${publisher.name}.${pkg.name}`,
        versions: versionDirs.map(v => v.name),
        latest: {
          name: manifest?.PackageName || pkg.name,
          publisher: manifest?.Publisher || publisher.name,
          version: versionDirs[0].name,
          description: manifest?.Description || '',
          tags: manifest?.Tags ? manifest.Tags.split(',').map(t => t.trim()) : [],
          homepage: manifest?.Homepage || '',
          license: manifest?.License || '',
          licenseUrl: manifest?.LicenseUrl || '',
          author: manifest?.Author || '',
          installerType: manifest?.InstallerType || ''
        },
        installers: manifest?.Installers || [],
        updatedAt: new Date().toISOString()
      };
    } catch (error) {
      console.error(`Error processing ${pkg.name}:`, error.message);
      return null;
    }
  }

  async processPublisher(publisher) {
    try {
      console.log(`Processing publisher: ${publisher.name}`);
      const packages = await this.fetchWithRetry(publisher.url);
      
      const packagePromises = packages
        .filter(pkg => pkg.type === 'dir')
        .map(pkg => this.processPackage(publisher, pkg));

      const results = await Promise.all(packagePromises);
      return results.filter(Boolean);
    } catch (error) {
      console.error(`Error processing publisher ${publisher.name}:`, error.message);
      return [];
    }
  }

  async processBatch(publishers) {
    const results = await Promise.all(
      publishers.map(pub => this.processPublisher(pub))
    );
    return results.flat();
  }

  async generateApiFiles() {
    try {
      console.log('Starting API generation...');
      
      // Tüm yayıncıları al
      const publishers = await this.fetchWithRetry('/repos/microsoft/winget-pkgs/contents/manifests');
      const validPublishers = publishers.filter(p => p.type === 'dir');
      
      console.log(`Found ${validPublishers.length} publishers`);

      // Yayıncıları küçük gruplara böl
      const batches = [];
      for (let i = 0; i < validPublishers.length; i += this.concurrentLimit) {
        batches.push(validPublishers.slice(i, i + this.concurrentLimit));
      }

      // Her grubu sırayla işle
      for (const [index, batch] of batches.entries()) {
        const batchPackages = await this.processBatch(batch);
        this.packages.push(...batchPackages);
        
        console.log(`Processed batch ${index + 1}/${batches.length} (${this.packages.length} total packages)`);
      }

      // API dosyalarını oluştur
      await fs.mkdir('dist/v2', { recursive: true });
      await fs.mkdir('dist/v2/publishers', { recursive: true });

      // Ana paket listesi
      await fs.writeFile(
        'dist/v2/packages.json',
        JSON.stringify(this.packages, null, 2)
      );

      // Yayıncılara göre grupla
      const byPublisher = {};
      for (const pkg of this.packages) {
        const publisher = pkg.latest.publisher;
        if (!byPublisher[publisher]) {
          byPublisher[publisher] = [];
        }
        byPublisher[publisher].push(pkg);
      }

      // Yayıncı dosyaları
      for (const [publisher, packages] of Object.entries(byPublisher)) {
        await fs.writeFile(
          `dist/v2/publishers/${publisher}.json`,
          JSON.stringify(packages, null, 2)
        );
      }

      console.log(`Successfully processed ${this.packages.length} packages`);
    } catch (error) {
      console.error('Error generating API:', error.message);
    }
  }
}

// API oluşturmayı başlat
console.log('Starting Winget API generator...');
const generator = new WingetDetailedGenerator();
generator.generateApiFiles();