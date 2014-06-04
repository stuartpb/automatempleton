var useragent = 'Automatempleton/0.0'
  + ' (http://github.com/stuartpb/automatempleton; stuart@testtrack4.com)';
var wikihost = 'en.wikipedia.org';

var http = require('http');
var url = require('url');
var fs = require('fs');
var yaml = require('js-yaml');

function wpApiQuery(params, cb) {
  var req = http.request({
    host: wikihost,
    path: url.format({
      pathname: '/w/api.php',
      query: params
    }),
    headers: {
      'User-Agent': useragent
    }
  }, function(res) {
    var bodylist = [];
    res.on('data', function (chunk) {
      bodylist.push(chunk);
    });
    res.on('end', function(){
      cb(null,res.statusCode,JSON.parse(bodylist.join('')));
    });
  });

  req.on('error', function(e) {
    cb(e);
  });

  req.end();
}

var targetTemplate = process.argv[2];

var pages = [];
var eicontinue = process.argv[3] || null;
var curpage = 0;
var timerId;
//Whether we're waiting for the response to a request.
var popWaiting = false;

var outFilename = targetTemplate + '.yaml';
var outFile = fs.openSync(outFilename, 'a+');
var readStream = fs.createWriteStream(outFilename,
  {encoding:'utf8', fd: outFile, autoClose: false});
var existingContent;
var chunk = readStream.read();
while (chunk) {
  existingContent += chunk;
  chunk = readStream.read();
}
var existing = Object.create(null);
if (existingContent) {
  existing = yaml.load(existingContent);
}

//Reset the pages data from an API response.
function populatePagesArray(err, code, body) {
  if (!err && code == 200) {
    pages = body.query.embeddedin;
    curpage = 0;
    if (body['query-continue']) {
      eicontinue = body['query-continue'].embeddedin.eicontinue;
    } else {
      eicontinue = undefined;
    }
    popWaiting = false;
    process.stdout.write('\n');
  } else {
    if (err)
      console.error(err);
    else
      console.error(
        'Error: got code ' + code + ' populating transclusions:'
          + '\n\n' + body);
    process.exit(1);
  }
}

function parseTemplate(source) {
  var params = source.split('|');
  // trim the end of the template off the last param
  params[params.length-1] = params[params.length-1].slice(0,-2);

  var position = 1;
  var results = Object.create(null);

  for (var i = 1; i < params.length; i++) {
    var sep = params[i].indexOf('=');

    if (sep > -1) {
      results[params[i].slice(0, sep).trim()] =
        params[i].slice(sep + 1).trim();
    } else {
      results[position] = params[i].trim();
      ++position;
    }
  }

  return results;
}

function reEscape(str) {
  return str.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
}

function findTemplate(content) {
  var start = new RegExp('\\{\\{\\s*' +
    reEscape(targetTemplate).replace(/[_ ]/g,'[_ ]')
    + '\\s*(\\||\\}\\})', 'i');
  var braces = /\{\{|\}\}/g;
  var depth = 1;
  var result = start.exec(content);
  var first;
  if (result) {
    if (result[1]=='}}') return result[0];
    first = result.index;
    braces.lastIndex = result.index + result[0].length;
    while (depth > 0 && result) {
      result = braces.exec(content);
      if (result) depth += (result[0] == '{{' ? 1 : -1);
    }
    if (result) return content.slice(first, result.index + result[0].length);
  } return null;
}

function handlePage (err, code, body) {
  if (!err && code == 200) {
    var page = body.query.pages[body.query.pageids[0]];
    var content = page.revisions[0]['*'];
    var templateContent = findTemplate(content);
    if (templateContent) {
      var record = Object.create(null);
      record[page.title] = parseTemplate(templateContent);
      fs.writeSync(outFile,yaml.dump(record));
    } else {
      console.error("Warning: template not found on " + page.title);
    }
  } else {
    if (err)
      console.error(err);
    else
      console.error(
        'Error: got code ' + code + ' reading page:'
          + '\n\n' + body);
    process.exit(1);
  }
}

function queryPage(page) {
  //Only query pages in the main namespace
  if (page.ns != 0){
    console.log('Skipping non-article '+page.title);
  } else if (existing[page.title]) {
    console.log('Skipping existing '+page.title);
  } else {
    console.log('Getting content for '+page.title);
    wpApiQuery({
      action: 'query',
      prop: 'revisions',
      rvprop: 'content',
      titles: page.title,
      format: 'json',
      indexpageids: true
    }, handlePage);
  }
}

function timer_cb() {
  //If we've run through all the pages we have and there are still more
  if((curpage == pages.length && eicontinue) || pages.length == 0) {
    if(popWaiting) {
      process.stdout.write('.');
    } else {
    //Query the API for the next group of pages
      process.stdout.write('Querying API for next group of pages ('+eicontinue+')...');

      var apiparams = {
        action: 'query',
        list: 'embeddedin',
        eititle: 'Template:'+targetTemplate,
        // last I checked, the largest limit Wikipedia
        // is comfortable with is 500, which is plenty
        eilimit: 500,
        format: 'json'
      };

      if(eicontinue) apiparams.eicontinue = eicontinue;

      popWaiting = true;
      wpApiQuery(apiparams, populatePagesArray);
  }
  //Otherwise, if we're still parsing the current batch
  //(not done or waiting for the next batch of pages)
  } else if(curpage < pages.length) {
    queryPage(pages[curpage++]);
  // Otherwise, if we're done
  // (the previous condition falling through
  // indicates curpage == pages.length,
  // and the last query didn't have any more continuation tokens)
  } else if(!eicontinue) {
    // Stop the timer
    clearInterval(timerId);
  }
}

// Run
if(!targetTemplate) {
  console.error('This script must be run with a target template as a parameter.');
} else if (!outFilename) {
  console.error('This script must be run with an output filename.');
} else {
  console.log('Getting pages for "'+targetTemplate+'"...');
  timerId = setInterval(timer_cb,250);
}
