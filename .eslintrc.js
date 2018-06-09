// https://eslint.org/docs/user-guide/configuring

module.exports = {
  root: true,
  parserOptions: {
    parser: 'babel-eslint',
    sourceType: 'module'
  },
  env: {
    browser: true,
  },
  extends: [
    'airbnb-base'
  ],
  'rules': {
    // allow debugger during development
    'no-debugger': process.env.NODE_ENV === 'production' ? 2 : 0,
    'function-paren-newline': 'off',
    'no-underscore-dangle': 'off',
    'import/extensions': 'always',
    'max-len': ['error', 150],
    'no-plusplus': ["error", { "allowForLoopAfterthoughts": true }]
  }
}
