// scripts/generate-api.js
const axios = require('axios');
const fs = require('fs/promises');
const path = require('path');
const yaml = require('yaml');

class WingetApiGenerator {
  constructor() {
    // GitHub token'ı olmadan da çalışabilmesi için basic auth kaldırıldı
    this.api = axios.create({
      baseURL: 'https://api.github.com',
      headers: {
        Accept: 'application/vnd.github.v3+json'
      }
    });
    
    this.packages = [];
  }

  async fetchWithRetry(url, retries = 3) {
    for (let i = 0; i < retries; i++) {
      try {
        // API çağrısı öncesi kısa bekleme ekleyelim
        await new Promise(resolve => setTimeout(resolve, 1000));
        const response = await this.api.get(url);
        return response.data;
      } catch (error) {
        console.error(`Error fetching ${url}:`, error.message);
        if (i === retries - 1) throw error;
        // Hata durumunda daha uzun bekleyelim
        await new Promise(resolve => setTimeout(resolve, 2000 * (i + 1)));
      }
    }
  }

  async fetchPackageContent(publisher, packageName) {
    try {
      const url = `/repos/microsoft/winget-pkgs/contents/manifests/${publisher}/${packageName}`;
      return await this.fetchWithRetry(url);
    } catch (error) {
      console.error(`Error fetching package content for ${publisher}/${packageName}:`, error.message);
      return null;
    }
  }

  async processPublisherDirectory(dir) {
    try {
      console.log(`Processing publisher: ${dir.name}`);
      const packages = await this.fetchWithRetry(dir.url);
      
      for (const pkg of packages) {
        if (pkg.type === 'dir') {
          const content = await this.fetchPackageContent(dir.name, pkg.name);
          if (content) {
            const packageInfo = {
              id: `${dir.name}.${pkg.name}`,
              versions: [],
              latest: {
                name: pkg.name,
                publisher: dir.name,
                version: 'latest',
                description: '',
                tags: []
              },
              updatedAt: new Date().toISOString()
            };
            
            this.packages.push(packageInfo);
            console.log(`Added package: ${packageInfo.id}`);
          }
        }
      }
    } catch (error) {
      console.error(`Error processing directory ${dir.name}:`, error.message);
    }
  }

  async generateApiFiles() {
    try {
      const publishers = await this.fetchWithRetry('/repos/microsoft/winget-pkgs/contents/manifests');
      
      for (const dir of publishers) {
        if (dir.type === 'dir') {
          await this.processPublisherDirectory(dir);
        }
      }

      // API dosyalarını oluştur
      await fs.mkdir('dist/v2', { recursive: true });
      await fs.writeFile(
        'dist/v2/packages.json',
        JSON.stringify(this.packages, null, 2)
      );

      console.log(`Successfully processed ${this.packages.length} packages`);
    } catch (error) {
      console.error('Error generating API:', error.message);
    }
  }
}

// API oluşturmayı başlat
const generator = new WingetApiGenerator();
generator.generateApiFiles();