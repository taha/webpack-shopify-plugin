const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const Shopify = require('shopify-api-node');
const crypto = require('crypto');
const _ = require('lodash');

var compileError = function(compilation, error) {
  compilation.errors.push(new Error(error))
}

function checksum(str, algorithm, encoding) {
    return crypto
        .createHash(algorithm || 'md5')
        .update(str, 'utf8')
        .digest(encoding || 'hex')
}

function ShopifyUploader(config) {
  this.config = config;
  this.shopify = new Shopify(_.pick(this.config, ['shopName', 'apiKey', 'password']));
  this.startTime = Date.now();
  this.prevCheckMap = this.loadChecksumLock();
  this.nextCheckMap = {};
}

ShopifyUploader.prototype.loadChecksumLock = function() {
  const filename = path.join(this.config.themeBase, 'ShopifyUploader.lock');
  var checkMap = {};

  try {
    fs.accessSync(filename, fs.F_OK);
    checkMap = JSON.parse(fs.readFileSync(filename));
  } catch (e) {}

  return checkMap;
}

ShopifyUploader.prototype.apply = function(compiler) {
  const that = this;
  const themeId = this.config.themeId;
  const themeBasePath = this.config.themeBase;
  const themeFolders = ['assets', 'config', 'layout', 'snippets', 'locales', 'templates'];
  const themeFoldersRegex = new RegExp(_.escapeRegExp(themeBasePath) + "/(("+themeFolders.join("|")+")/(.+?))$");

  // Create checksum map
  compiler.plugin('emit', (compilation, callback) => {
    const checkMap = _.extend({}, this.prevCheckMap);

    Object.keys(compilation.assets).forEach((filename) => {
      const asset = compilation.assets[filename];
      checkMap[filename] = checksum(asset.source(), 'md5');
    });
  
    // Set as the next state of the checksum
    this.nextCheckMap = checkMap;
    
    // Convert the checksum map to json to store in a file
    const checkMapJson = JSON.stringify(checkMap);
    compilation.assets['ShopifyUploader.lock'] = {
      source: function() {
        return checkMapJson;
      },
      size: function() {
        return checkMapJson.length;
      }
    };

    callback();
  });

  compiler.plugin('after-emit', (compilation, callback) => {
    const files = [];
    var filesFailed = 0;
    var filesElapsed = 0;

    Object.keys(compilation.assets).forEach((filename) => {
      const asset = compilation.assets[filename];
      if (asset.emitted && asset.existsAt) {
        const match = asset.existsAt.match(themeFoldersRegex);
        
        // If it is within the shopify dir structure
        if (match) {
          // Now we need to check if the file actually changed from the version
          // that's already uploaded on shopify from the last sync
          if (this.prevCheckMap[filename] !== this.nextCheckMap[filename]) {
            // After this, we make a VERY dangerous assumption that the file WILL upload successfuly
            // @todo: Fix this shit          
            files.push({
              path: asset.existsAt,
              target: match[1],
              filename: filename
            });
          }
        }
      }
    });
    
    if (files.length === 0) {
      callback();
      return;
    }

    console.log();
    console.log("ShopifyUploader:", chalk.blue("Starting..."));
    
    // Start this shit
    uploadFilesChunked(_.chunk(files, 2), () => {
      console.log("ShopifyUploader: " + chalk.blue("Finished (%d total, %d uploaded, %d failed)."),
        files.length, files.length - filesFailed, filesFailed);
      callback();
    });
    
    function uploadFilesChunked(chunks, cb) {
      var time = process.hrtime();

      // @todo: Make trailing
      var upload = () => {
        var diff = process.hrtime(time);
        var diffMs = diff[0] * 1e3 + diff[1] * 1e-6; // [seconds, nanoseconds] -> milliseconds
        
        if (chunks.length > 0) {
          // If less than a second, wait for the remainder, then resume, trailing
          if (filesElapsed > 0 && diffMs < 1000) {
            setTimeout(upload, 1000 - diffMs);
          } else {
            // reset the time counter
            time = process.hrtime();
            // Process
            uploadFiles(chunks.shift(), upload);
          }
        } else {
          cb && cb();
        }
      }
      
      // start
      upload();
    }
    
    function uploadFiles(files, cb) {
      cb = _.after(files.length, cb);
      files.forEach((file) => {
        uploadFile(file, cb);
      });
    }
    
    function uploadFile(file, cb) {
      that.shopify.asset.update(themeId, {
        key: file.target,
        attachment: fs.readFileSync(file.path).toString("base64")
      }).then((response) => {
        filesElapsed++;
        console.log(chalk.green("%s Uploaded [remaining %d]"), file.target, files.length - filesElapsed);
        cb();
      }).catch((error) => {
        filesFailed++;
        filesElapsed++;
        console.error(chalk.red("%s failed to upload (%s) [remaining %d]"), file.target, error.message,
          files.length - filesElapsed);
        cb();
      });
    }
  });
};

module.exports = ShopifyUploader;