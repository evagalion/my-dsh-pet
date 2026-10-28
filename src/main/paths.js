'use strict'

const path = require('node:path')

// __dirname = <root>/src/main  ->  <root>
const ROOT = path.resolve(__dirname, '..', '..')
const ASSETS_DIR = path.join(ROOT, 'assets')

module.exports = { ROOT, ASSETS_DIR }
