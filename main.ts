import * as path from 'path';
import * as util from 'util';
import * as fs from 'fs-extra';
import axios from 'axios';
import { Octokit } from '@octokit/core'

const execAsync = util.promisify(require('node:child_process').exec);

export interface Plugin {
  name: string;
  valid: boolean;
  version: string | null;
  packaged: boolean;
}

export class Main {
  private octokit = new Octokit({
    auth: process.env.GITHUB_TOKEN
  });

  private githubProjectOwner = 'homebridge';
  private githubProjectRepo = 'plugin-repo'
  private targetRelease = 'v1';

  private workDir = path.join(__dirname, 'work');

  private pluginList: string[] = [];
  private pluginMap: Plugin[] = [];

  private release: {
    id: number;
    tag_name: string;
    upload_url: string;
    assets: {
      id: number;
      name: string;
      label: string;
      created_at: string;
      updated_at: string;
    }[];
  }

  private pluginFilter: string[] = [
    'homebridge-config-ui-x',
    'homebridge-music' // darwin only
  ];

  async run() {
    try {
      await this.getGitHubRelease(this.targetRelease);
      await this.getVerifiedPluginsList();
      await this.getLatestVersions();
      await this.bundlePlugins();
      await this.uploadAssets();
      await this.removeOldAssets();
    } catch (e) {
      console.error('Error', e.message, e);
      process.exit(1);
    }
  }

  /**
   * Get the verified plugins list
   */
  async getVerifiedPluginsList() {
    const response = await axios.get<string[]>('https://raw.githubusercontent.com/homebridge/verified/master/verified-plugins.json');
    this.pluginList = response.data.filter(x => !this.pluginFilter.includes(x));
    console.log(`Processing ${this.pluginList.length} verified plugins...`);

    // add the homebridge package as well
    this.pluginList.unshift('homebridge');
  }

  /**
   * Get the 'latest' version for the plugins
   */
  async getLatestVersions() {
    for (const pluginName of this.pluginList) {
      try {
        const response = await axios.get(`https://registry.npmjs.org/${pluginName}/latest`);

        const plugin: Plugin = {
          name: pluginName,
          valid: true,
          version: response.data.version,
          packaged: false,
        };

        // check if an update is required
        if (
          this.release.assets.find(x => x.name === this.pluginAssetName(plugin, 'tar.gz')) &&
          this.release.assets.find(x => x.name === this.pluginAssetName(plugin, 'sha256'))
        ) {
          console.log(`${plugin.name} v${plugin.version} is up to date.`);
        } else {
          this.pluginMap.push(plugin);
        }

      } catch (e) {
        console.log(`ERROR: ${pluginName}`, e.message);
      }
    }
  }

  /**
   * Get the github release for the project
   * @param version 
   */
  async getGitHubRelease(tag: string) {
    const response = await this.octokit.request('GET /repos/{owner}/{repo}/releases', {
      owner: this.githubProjectOwner,
      repo: this.githubProjectRepo,
    });

    this.release = response.data.find(x => x.tag_name === tag);
    if (!this.release) {
      throw new Error(`Release with tag "${tag}" does not exist`);
    }
  }

  /**
   * Create a bundle for the verified plugins
   */
  async bundlePlugins() {
    console.log(`Generating update bundles for ${this.pluginMap.length} plugins...`);
    for (const plugin of this.pluginMap) {
      const targetDir = path.join(this.workDir, plugin.name.replace('/', '@') + '@' + plugin.version);

      try {
        if (!await fs.pathExists(path.join(this.workDir, this.pluginAssetName(plugin, 'tar.gz'))) || !await fs.pathExists(path.join(this.workDir, this.pluginAssetName(plugin, 'sha256')))) {
          console.log('Target:', targetDir);

          // refresh target directory
          await fs.remove(targetDir);
          await fs.mkdirp(targetDir);

          // create temp package.json
          await fs.writeJson(path.join(targetDir, 'package.json'), { private: true });

          // install plugin
          await execAsync(`npm install ${plugin.name}@${plugin.version}`, {
            cwd: targetDir,
            env: Object.assign({
              'npm_config_audit': 'false',
              'npm_config_fund': 'false',
              'npm_config_update_notifier': 'false',
              'npm_config_auto_install_peers': 'true',
              'npm_config_global_style': 'true',
              'npm_config_ignore_scripts': 'true',
              'npm_config_package_lock': 'false',
              'npm_config_loglevel': 'error',
            }, process.env),
          });

          // remove temp package.json and node_modules/.package-lock.json
          await fs.remove(path.join(targetDir, 'package.json'));
          await fs.remove(path.join(targetDir, 'node_modules', '.package-lock.json'));

          // package plugin
          await execAsync(`tar -C ${targetDir}/node_modules --format=posix -czf ${this.pluginAssetName(plugin, 'tar.gz')} .`, {
            cwd: this.workDir,
          });

          // shasum 256 the package
          await execAsync(`shasum -a 256 ${this.pluginAssetName(plugin, 'tar.gz')} > ${this.pluginAssetName(plugin, 'sha256')}`, {
            cwd: this.workDir,
          });

          // remove target directory
          await fs.remove(targetDir);
        }
        plugin.packaged = true;
      } catch (e) {
        console.log(`Failed to pack ${plugin.name}`, e.message);
        await fs.remove(targetDir);
        await fs.remove(path.join(this.workDir, this.pluginAssetName(plugin, 'tar.gz')));
        await fs.remove(path.join(this.workDir, this.pluginAssetName(plugin, 'sha256')));
      }
    }
  }

  /**
   * Upload assets to github release
   */
  async uploadAssets() {
    for (const plugin of this.pluginMap) {
      for (const assetType of ['tar.gz', 'sha256']) {
        const assetName = this.pluginAssetName(plugin, assetType);
        const assetPath = path.join(this.workDir, assetName);

        const existingAsset = this.release.assets.find(x => x.name === assetName);
        if (existingAsset) {
          await this.deleteAsset(existingAsset);
        }

        const fileBuffer = await fs.readFile(assetPath);

        await this.octokit.request('POST /repos/{owner}/{repo}/releases/{release_id}/assets', {
          owner: this.githubProjectOwner,
          repo: this.githubProjectRepo,
          url: this.release.upload_url,
          release_id: this.release.id,
          name: assetName,
          label: `${plugin.name}@${plugin.version}.${assetType}`,
          headers: {
            'content-type': 'application/octet-stream'
          },
          data: fileBuffer,
        });

        console.log(`Uploaded ${assetName}`);
      }
    }
  }

  /**
   * Delete previous versions of the assets
   */
  async removeOldAssets() {
    for (const plugin of this.pluginMap) {
      for (const assetType of ['tar.gz', 'sha256']) {
        const assetsToRemove = this.release.assets
          .filter(x => {
            // find old assets (this will not include the assets we just uploaded!)
            return x.label.substring(0, x.label.lastIndexOf('@')) === plugin.name && x.name.endsWith(assetType);
          })
          .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()) // sort by oldest to newest

        // remove the previously newest asset (last item in array), preventing it from being deleted
        assetsToRemove.pop()

        for (const asset of assetsToRemove) {
          await this.deleteAsset(asset);
        }
      }
    }
  }

  /**
   * Delete a release asset
   * @param asset 
   */
  async deleteAsset(asset) {
    try {
      await this.octokit.request('DELETE /repos/{owner}/{repo}/releases/assets/{asset_id}', {
        owner: this.githubProjectOwner,
        repo: this.githubProjectRepo,
        asset_id: asset.id,
      });
      console.log(`Purged ${asset.name}...`)
    } catch (e) {
      console.error(`Failed to delete asset:`, asset.name, e.messsage)
    }
  }

  pluginAssetName(plugin: Plugin, ext: string) {
    return `${plugin.name.replace('/', '@')}-${plugin.version}.${ext}`;
  }
}

// bootstrap and urn
(async () => {
  const main = new Main();
  await main.run();
})();
