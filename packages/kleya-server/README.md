# @centerforagenticai/kleya-server

The Kleya server runtime, which runs beside pi-durable. It has no root entry: import the subpath you need, for example `@centerforagenticai/kleya-server/grants`.

Status: skeleton. The subpaths exist and load; their contents arrive with later work packages.

Subpaths: `./grants`, `./context`, `./feed`, `./host`, `./host/chord`, `./tools`, `./tools/openapi`, `./interaction`, `./exec`, `./egress`, `./events`, `./testing`. Only `./host/chord` may use Node APIs; every other subpath runs on Node, in workerd and in browsers.

Licence: MIT.
