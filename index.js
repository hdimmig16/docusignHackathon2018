'use strict';
require('dotenv').config()
require("babel-polyfill");
const express = require('express')
const server = express()
const bodyParser = require('body-parser');
const path = require('path');


// configure body-parser to accept urlencoded bodies 
server.use(bodyParser.urlencoded({ extended: true, limit: '5mb' }))
  .use(bodyParser.json({  limit: '5mb' })); // and json 

const allowCrossDomain = (req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,PUT,POST,PATCH,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Content-Length, X-Requested-With');

  // intercept OPTIONS method
  if ('OPTIONS' == req.method) {
    res.send(200);
  }
  else {
    next();
  }
};
server.use(allowCrossDomain);

const port = process.env.PORT || 3000;

server.listen(port, () => console.info('Listening on port %s.', port));

// production routes
if(process.env.NODE_ENV === 'production') {
  console.log("Running production");
  // route registration
  server.use('/api', require('./dist/routes/test'));

}

// dev routes
else if(process.env.NODE_ENV === 'dev'){
  console.log("Running development");
  // route registration
  server.use('/api', require('./src/routes/test'));

}

server.use('/', express.static(path.join(__dirname, 'static')))

// 404 errors
server.use((req, res, next) => {
  res.status(404).json({ message: 'Page Not Found.' });
});

module.exports = server;