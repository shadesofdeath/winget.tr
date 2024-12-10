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
        
        const remaining = parseInt(response.headers['x-ratelimit-remaining'] || '0');
        if (remaining < 10) {
          const resetTime = parseInt(response.headers['x-ratelimit-reset'] || '0') * 1000;
          const waitTime = resetTime - Date.now() + 1000;
          if (waitTime > 0) {
            console.log(`Rate limit low, waiting ${Math.ceil(waitTime/1000)} seconds...`);
            await this.sleep(waitTime);
          }
        }

        return response.data;
      } catch (error) {
        if (error.response?.status === 429) {
          console.log('Rate limit exceeded, waiting 30 seconds...');
          await this.sleep(30000);
          continue;
        }
        if (i === retries - 1) throw error;
        const waitTime = Math.pow(2, i) * 1000;
        await this.sleep(waitTime);
      }
    }
  }

  async fetchLatestManifest(publisher, packageName, versions) {
    try {
      const latestVersion = versions[0];
      const versionFiles = await this.fetchWithRetry(latestVersion.url);
      
      const yamlFile = versionFiles.find(f => 
        f.name.endsWith('.yaml') || f.name.endsWith('.yml')
      );

      if (!yamlFile) return null;

      const content = await this.fetchWithRetry(yamlFile.download_url);
      return yaml.parse(content);
    } catch (error) {
      console.error(`Error fetching manifest for ${publisher}/${packageName}:`, error.message);
      return null;
    }
  }

  async processPackage(publisher, pkg) {
    try {
      const versions = await this.fetchWithRetry(pkg.url);
      const versionDirs = versions
        .filter(v => v.type === 'dir')
        .sort((a, b) => b.name.localeCompare(a.name));

      const manifest = await this.fetchLatestManifest(publisher.name, pkg.name, versionDirs);

      if (!manifest) {
        console.log(`No manifest found for ${publisher.name}/${pkg.name}`);
        return null;
      }

      return {
        id: `${publisher.name}.${pkg.name}`,
        versions: versionDirs.map(v => v.name),
        latest: {
          name: manifest.PackageName || pkg.name,
          publisher: manifest.Publisher || publisher.name,
          version: versionDirs[0].name,
          description: manifest.Description || '',
          tags: manifest.Tags ? manifest.Tags.split(',').map(t => t.trim()) : [],
          homepage: manifest.Homepage || '',
          license: manifest.License || '',
          licenseUrl: manifest.LicenseUrl || '',
          author: manifest.Author || '',
          installerType: manifest.InstallerType || ''
        },
        installers: manifest.Installers || [],
        moniker: manifest.Moniker || '',
        minOSVersion: manifest.MinOSVersion || '',
        productCode: manifest.ProductCode || '',
        updatedAt: new Date().toISOString(),
        createdAt: new Date(pkg.created_at || Date.now()).toISOString()
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
        
        // Her 10 batch'te bir dosyaları kaydet (ara yedekleme)
        if (index % 10 === 0) {
          await this.saveFiles();
          console.log('Saved intermediate results...');
        }
      }

      // Final kayıt
      await this.saveFiles();
      console.log(`Successfully processed ${this.packages.length} packages`);
      
      // İstatistik dosyasını oluştur
      await this.generateStats();
      
    } catch (error) {
      console.error('Error generating API:', error.message);
    }
  }

  async saveFiles() {
    // Dizin yapısını oluştur
    await fs.mkdir('dist/v2', { recursive: true });
    await fs.mkdir('dist/v2/publishers', { recursive: true });
    await fs.mkdir('dist/v2/packages', { recursive: true });

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

    // Tekil paket dosyaları
    for (const pkg of this.packages) {
      await fs.writeFile(
        `dist/v2/packages/${pkg.id}.json`,
        JSON.stringify(pkg, null, 2)
      );
    }
  }

  async generateStats() {
    const stats = {
      totalPackages: this.packages.length,
      totalPublishers: new Set(this.packages.map(p => p.latest.publisher)).size,
      totalVersions: this.packages.reduce((acc, pkg) => acc + pkg.versions.length, 0),
      lastUpdate: new Date().toISOString(),
      popularTags: this.getPopularTags(),
      topPublishers: this.getTopPublishers()
    };

    await fs.writeFile(
      'dist/v2/stats.json',
      JSON.stringify(stats, null, 2)
    );
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
}

// API oluşturmayı başlat
console.log('Starting Winget API generator with rate limiting...');
const generator = new WingetDetailedGenerator();
generator.generateApiFiles();