# Outofbox Skin Sync #

Node.js приложение для синхронизации локального каталога и каталога на сайте под управлением outofbox.ru

## Запуск ##

```
node index.js path/to/config.yml
```

## Конфигурация ##

Пример конфига есть в `config.yml.dist`:

```
watch:
    path: 'path/to/templates/files/'

sync:
    base_uri: 'http://outofbox-domain.tld/_api/skins/skin-name/files/'
    token: ~
```

`watch.path` – путь до каталога, в котором надо отслеживать изменения
`sync.base_uri` – путь до API шаблона
`sync.token` – секретный токен