const chokidar = require('chokidar');
const request = require('request');
const rp = require('request-promise');
const log = require('fancy-log');
const chalk = require('chalk');
const fs = require('fs');
const path = require('path');
const YAML = require('yaml');
const PromisePool = require('es6-promise-pool');
const { Confirm } = require('enquirer');

if (process.argv.length < 3) {
    console.log('Usage: node index.js <config.yml>');
    return;
}

const config_file_path = path.resolve(process.argv[2]);

if (!fs.existsSync(config_file_path)) {
	console.error('Config file not found at path', chalk.cyan("'" + config_file_path + "'"));
	return;
}

const config_file_dir = path.dirname(config_file_path);

const config_in_file = YAML.parse(fs.readFileSync(config_file_path, 'utf8'));
const defaults = {
    ignored: [
        /(^|[\/\\])\../, // ignore dotfiles
        /node_modules/
    ],
    sync: {
        since_file: null
    }
};

const config = Object.assign(defaults, config_in_file);

let watch_path;
if (path.isAbsolute(config.watch.path)) {
	watch_path = config.watch.path;
} else {
	watch_path = path.resolve(config_file_dir + path.sep + config.watch.path);
}

const startWatcher = () => {
    log('Start watch', chalk.cyan("'" + watch_path + "'"), 'and sync with', chalk.cyan("'" + config.sync.base_uri + "'"));

    const watcher = chokidar.watch(watch_path, {
        ignored: config.ignored,
        persistent: true,
        ignoreInitial: true
    });

    var queue = [], current_task = null;

    var executeNextTask = function() {
        if (current_task) {
            return;
        }

        if (queue.length > 0) {
            current_task = queue.shift();

            const event = current_task[0],
                fs_path = current_task[1];

            log('Path', chalk.magenta("'" + fs_path + "'"), chalk.cyan("'" + event + "'"));

            const relative_fs_path = path.relative(watch_path, fs_path);
            let resource_url = config.sync.base_uri + relative_fs_path;

            let promise = null;

            let headers = {
                'X-Skins-Sync-Token': config.sync.token
            };

            switch (event) {
                case 'add':
                case 'change':
                    promise = rp({
                        method: 'POST',
                        uri: resource_url,
                        headers: headers,
                        formData: {
                            content: fs.createReadStream(fs_path)
                        },
                        resolveWithFullResponse: true
                    })
                        .then(function(response) {
                            log(chalk.cyan('POST'), 'request success:', chalk.bgBlack(response.statusCode));
                        })
                        .catch(function (error) {
                            log(chalk.cyan('POST'), 'request error:', chalk.bgRed(error.response.statusCode));
                        })
                    ;
                    break;

                case 'unlink':
                    promise = rp({
                        method: 'DELETE',
                        uri: resource_url,
                        headers: headers,
                        resolveWithFullResponse: true
                    })
                        .then(function(response) {
                            log(chalk.red('DELETE'), 'request success:', chalk.bgBlack(response.statusCode));
                        })
                        .catch(function (error) {
                            log(chalk.red('DELETE'), 'request error:', chalk.bgRed(error.response.statusCode));
                        })
                    ;
                    break;

                case 'addDir':
                    promise = rp({
                        method: 'POST',
                        uri: resource_url + '/',
                        headers: headers,
                        resolveWithFullResponse: true
                    })
                        .then(function(response) {
                            log(chalk.cyan('POST'), 'request success:', chalk.bgBlack(response.statusCode));
                        })
                        .catch(function (error) {
                            log(chalk.cyan('POST'), 'request error:', chalk.bgRed(error.response.statusCode));
                        })
                    ;
                    break;

                case 'unlinkDir':
                    promise = rp({
                        method: 'DELETE',
                        uri: resource_url + '/',
                        headers: headers,
                        resolveWithFullResponse: true
                    })
                        .then(function(response) {
                            log(chalk.red('DELETE'), 'request success:', chalk.bgBlack(response.statusCode));
                        })
                        .catch(function (error) {
                            log(chalk.red('DELETE'), 'request error:', chalk.bgRed(error.response.statusCode));
                        })
                    ;
                    break;
            }

            if (promise) {
                promise.finally(() => {
                    current_task = null;
                    executeNextTask();
                });
            } else {
                current_task = null;
                executeNextTask();
            }
        }
    };

    watcher.on('all', async (event, fs_path) => {
        queue.push([ event, fs_path ]);
        executeNextTask();
    });
};

if (config.sync.since_file) {
    const since_file_path = config_file_dir + '/' + config.sync.since_file;

    if (!fs.existsSync(since_file_path)) {
        log.error('Since file not found at path', chalk.cyan("'" + since_file_path + "'"));
        return;
    }

    const since__date_number = Date.parse(fs.readFileSync(since_file_path, 'utf8'));
    const sinceDate = new Date();

    if (!isNaN(since__date_number)) {
        sinceDate.setTime(since__date_number);
    }

    log('Pull changed files since', chalk.cyan("'" + sinceDate.toISOString() + "'"));

    const now = new Date();

    let headers = {
        'X-Skins-Sync-Token': config.sync.token
    };

    rp({
        method: 'GET',
        uri: config.sync.base_uri,
        qs: {
            since: sinceDate.toISOString()
        },
        headers: headers,
        resolveWithFullResponse: true,
        json: true
    })
        .then(function(response) {
            return new Promise((resolve, reject) => {
                if (response.body.files.length === 0) {
                    log('No files was changed since', chalk.cyan("'" + sinceDate.toISOString() + "'"));
                    resolve(0);
                    return;
                }

                log(chalk.cyan(response.body.files.length), ' file(s) was changed:');
                response.body.files.forEach(file => {
                    log(file.path);
                });

                const prompt = new Confirm({
                    name: 'question',
                    message: 'Continue download these changes?'
                });

                function ensureDirectoryExistence(filePath) {
                    var dirname = path.dirname(filePath);
                    if (fs.existsSync(dirname)) {
                        return true;
                    }

                    ensureDirectoryExistence(dirname);
                    fs.mkdirSync(dirname);
                }

                prompt.run()
                    .then((download) => {
                        if (download) {
                            const concurrency = 3;

                            const createDownloadFilePromise = function(file) {
                                return new Promise((downloadFileResolve, downloadFileReject) => {
                                    request({
                                        url: file._links['download'],
                                        headers: headers,
                                        resolveWithFullResponse: true,
                                        encoding: null
                                    }, (error, response, body) => {
                                        if (!error) {
                                            var fs_filepath = watch_path + '/' + file.path;
                                            ensureDirectoryExistence(fs_filepath);

                                            fs.writeFile(fs_filepath, body, function (error) {
                                                if (error) {
                                                    downloadFileReject(error);
                                                } else {
                                                    log(chalk.cyan(file.path), 'downloaded');
                                                    downloadFileResolve(fs_filepath);
                                                }
                                            });
                                        } else {
                                            downloadFileReject(error);
                                        }
                                    });
                                })
                            };

                            const generateDownloadPromises = function * () {
                                for (var file_index in response.body.files) {
                                    var file = response.body.files[file_index];
                                    yield createDownloadFilePromise(file);
                                }
                            };

                            const downloadFilesPool = new PromisePool(generateDownloadPromises(), concurrency);

                            var downloadPoolPromise = downloadFilesPool.start();

                            downloadPoolPromise.then(() => {
                                fs.writeFile(since_file_path, now.toISOString(), function(error) {
                                    if (error) {
                                        reject(error);
                                    } else {
                                        resolve(0)
                                    }
                                });
                            }, function (error) {
                                reject(error);
                            });
                        } else {
                            resolve();
                        }
                    })
                    .catch((error) => {
                        reject(error);
                    })
                ;
            });
        })
        .then(() => {
            startWatcher();
        })
        .catch((error) => {
            log.error('Error during files sync', error);
        })
    ;
} else {
    startWatcher();
}