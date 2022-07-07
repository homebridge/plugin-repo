# Homebridge Plugin Repo

The purpose of this project is to help make the plugin installation process faster and more reliable for [verified Homebridge plugins](https://homebridge.io/w/Verified-Plugins).

### Why This Is Needed

Homebridge plugins are published and distributed to the NPM registry and installed using the `npm` cli tool.

While `npm` works for the most part, but later versions have become increasingly resource hungry and prone to failure on low powered devices with limited RAM and slow disk I/O (such as a Raspberry Pi).

When using `npm` to install a plugin, it has to fetch the metadata, and download, verify and extract the tarball for every dependency a plugin has individually. This can result in hundreds of HTTP requests every time a plugin is installed or updated. An error during any of these operations will often result in the plugin failing to install or update.

This project pre-bundles [verified Homebridge plugins](https://homebridge.io/w/Verified-Plugins), making them to available to download with all their dependencies in a single tarball. Additionally a SHA256 sum of the tarball is available so the integrity of the tarball can be verified after being downloaded to the users system.

A plugin installed via a bundle from this repo can be downloaded and installed in seconds, compared the minutes it might take for some plugins on the same hardware.

### How The Bundle Generation Process Works

Every 30 minutes a job is excuted using GitHub Actions to check updates to any [verified Homebridge plugins](https://homebridge.io/w/Verified-Plugins).

Plugins that require updates are then:

  1. Installed using `npm` in a clean work directory, post install scripts are disabled;
  2. then a `.tar.gz` bundle is created for the plugin, including all it's dependencies;
  3. then a `.sha256` checksum file is generated for the bundle;
  4. finally the resulting tarball and checksum file are uploaded to the [Homebridge Plugin Repo](https://github.com/homebridge/plugin-repo/releases/tag/v1).

The two most recent versions of a plugin are retained in the [Homebridge Plugin Repo](https://github.com/homebridge/plugin-repo/releases/tag/v1), older versions are purged automatically.

### How Plugins Are Installed Via Bundles

Bundles are only used on certain systems:

  * Debian-based Linux (via apt package): requires apt package update (=>1.0.27)
  * Docker: requires image update (=>2022-07-07)
  * Synology DSM 7: requires package update via DSM Package Center (=>3.0.7)

When a user requests a plugin to be installed or updated via the Homebridge UI the following workflow is executed:

  1. Check to if running on a compatible system
  2. Check the plugin is verified
  3. Check if a download bundle is available for the requested version
  4. Download the `.sha256` checksum for the bundle
  5. Download the `.tar.gz` tarball
  6. Check the integrity of the tarball with the checkum
  7. Create a backup of the existing plugin (if already installed)
  8. Extract the tarball
  9. Run `npm rebuild` in the plugin's root directory to have any post install scripts executed
  10. Update the local `package.json` with the plugin and it's version

If the extraction or `npm rebuild` steps fail, the old version of the plugin will be restored.

If at any step, the process fails, the Homebridge UI will fallback to using `npm` to complete the installation.

### Download Statistics

This project may impact the number of downloads you are seeing for your plugin via the NPM registry.

As such download statistics are available by from the [download-statistics.json](https://github.com/homebridge/plugin-repo/releases/download/v1/download-statistics.json) file. This file contains the total downloads for a plugin, as well as the download count for each version (including old versions that have been purged).

The `download-statistics.json` file is updated every 30 minutes.

If accessing the  file programatically, you will need add a `nonce` query string to the URL to prevent it being redirected to an older (deleted) version of the file.
