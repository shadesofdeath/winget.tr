const axios = require('axios');
const fs = require('fs/promises');
const path = require('path');
const yaml = require('yaml');

class WingetApiFastGenerator {
  constructor() {
    this.api = axios.create({
      baseURL: 'https://api.github.com',
      headers: {
        Accept: 'application/vnd.github.v3+json'
      }
    });
    
    this.packages = [];
    this.concurrentLimit = 10; // Aynı anda işlenecek paket sayısı
  }

  async fetchWithRetry(url) {
    try {
      await new Promise(resolve => setTimeout(resolve, 100)); // Minimal bekleme
      const response = await this.api.get(url);
      return response.data;
    } catch (error) {
      if (error.response?.status === 403) {
        console.log('Rate limit reached, short waiting...');
        await new Promise(resolve => setTimeout(resolve, 1000));
        return this.fetchWithRetry(url);
      }
      throw error;
    }
  }

  async processPublisherBatch(publishers) {
    return Promise.all(
      publishers.map(async (publisher) => {
        try {
          console.log(`Processing ${publisher.name}...`);
          const packages = await this.fetchWithRetry(publisher.url);
          
          const packagePromises = packages
            .filter(pkg => pkg.type === 'dir')
            .map(async (pkg) => {
              try {
                return {
                  id: `${publisher.name}.${pkg.name}`,
                  versions: ['latest'],
                  latest: {
                    name: pkg.name,
                    publisher: publisher.name,
                    version: 'latest',
                    description: '',
                    tags: []
                  },
                  updatedAt: new Date().toISOString()
                };
              } catch (error) {
                console.error(`Error processing ${pkg.name}:`, error.message);
                return null;
              }
            });

          const processedPackages = await Promise.all(packagePromises);
          return processedPackages.filter(Boolean);
        } catch (error) {
          console.error(`Error processing publisher ${publisher.name}:`, error.message);
          return [];
        }
      })
    );
  }

  async processBatches(publishers) {
    const batchSize = this.concurrentLimit;
    const batches = [];
    
    for (let i = 0; i < publishers.length; i += batchSize) {
      batches.push(publishers.slice(i, i + batchSize));
    }

    let processedTotal = 0;
    for (const batch of batches) {
      const results = await this.processPublisherBatch(batch);
      const packages = results.flat();
      this.packages.push(...packages);
      
      processedTotal += packages.length;
      console.log(`Processed ${processedTotal} packages so far...`);
    }
  }

  async generateApiFiles() {
    try {
      console.log('Starting fast API generation...');
      
      // Tüm yayıncıları al
      const publishers = await this.fetchWithRetry('/repos/microsoft/winget-pkgs/contents/manifests');
      const validPublishers = publishers.filter(p => p.type === 'dir');
      
      console.log(`Found ${validPublishers.length} publishers`);
      await this.processBatches(validPublishers);

      // Dizin yapısını oluştur
      await fs.mkdir('dist/v2', { recursive: true });
      await fs.mkdir('dist/v2/publishers', { recursive: true });

      // Ana paket listesini kaydet
      await fs.writeFile(
        'dist/v2/packages.json',
        JSON.stringify(this.packages, null, 2)
      );

      // Yayıncılara göre grupla ve kaydet
      const byPublisher = {};
      for (const pkg of this.packages) {
        const publisher = pkg.latest.publisher;
        if (!byPublisher[publisher]) {
          byPublisher[publisher] = [];
        }
        byPublisher[publisher].push(pkg);
      }

      // Her yayıncı için ayrı dosya oluştur
      for (const [publisher, packages] of Object.entries(byPublisher)) {
        await fs.writeFile(
          `dist/v2/publishers/${publisher}.json`,
          JSON.stringify(packages, null, 2)
        );
      }

      console.log(`Successfully processed ${this.packages.length} packages`);
      console.log('API generation completed!');
    } catch (error) {
      console.error('Error generating API:', error.message);
    }
  }
}

// API oluşturmayı başlat
console.log('Starting optimized winget API generator...');
const generator = new WingetApiFastGenerator();
generator.generateApiFiles();