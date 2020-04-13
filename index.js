const chokidar = require('chokidar');
const rp = require('request-promise');
const log = require('fancy-log');
const chalk = require('chalk');
const fs = require('fs');
const path = require('path');
const YAML = require('yaml');

if (process.argv.length < 3) {
    console.log('Usage: node index.js <config.yml>');
    return;
}

const config_in_file = YAML.parse(fs.readFileSync(process.argv[2], 'utf8'));
const defaults = {
};

const config = Object.assign(defaults, config_in_file);

const watch_path = path.resolve(config.watch.path);

const watcher = chokidar.watch(watch_path, {
    ignored: /(^|[\/\\])\../, // ignore dotfiles
    persistent: true,
    ignoreInitial: true
});

log('Start watch', chalk.magenta("'" + watch_path + "'"), 'and sync with', chalk.cyan("'" + config.sync.base_uri + "'"));

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