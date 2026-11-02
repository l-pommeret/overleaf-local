// Réglages d'Overleaf CE, plus le module ol-local (voir local/module).
const settings = require('./settings.js')

settings.moduleImportSequence = [
  'history-v1',
  'launchpad',
  'server-ce-scripts',
  'user-activate',
  'ol-local',
]

module.exports = settings
