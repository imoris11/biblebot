const express = require('express')
const bodyParser = require('body-parser')
const session = require('express-session')
const passport = require('passport')
const TwitterStrategy = require('passport-twitter')
const uuid = require('uuid/v4')
const security = require('./helpers/security')
const auth = require('./helpers/auth')
const cacheRoute = require('./helpers/cache-route')
const socket = require('./helpers/socket')
const requestAPI = require('request-promise')
const app = express()

app.set('port', (process.env.PORT || 5000))
app.set('views', __dirname + '/views')
app.set('view engine', 'ejs')

app.use(express.static(__dirname + '/public'))
app.use(bodyParser.json())
app.use(bodyParser.urlencoded({ extended: true }))
app.use(passport.initialize());
app.use(session({
  secret: 'keyboard cat',
  resave: false,
  saveUninitialized: true
}))

// start server
const server = app.listen(app.get('port'), function() {
  console.log('Node app is running on port', app.get('port'))
})

// initialize socket.io
socket.init(server)

// form parser middleware
var parseForm = bodyParser.urlencoded({ extended: false })


/**
 * Receives challenge response check (CRC)
 **/
app.get('/webhook/twitter', function(request, response) {

  var crc_token = request.query.crc_token

  if (crc_token) {
    var hash = security.get_challenge_response(crc_token, auth.twitter_oauth.consumer_secret)

    response.status(200);
    response.send({
      response_token: 'sha256=' + hash
    })
  } else {
    response.status(400);
    response.send('Error: crc_token missing from request.')
  }
})

/**
 * Cut the message into threads
 * 
 */
function formatMessage (message, tweet_id, link) {
    let sections = [];
    const sentences = message.split("."); //Split into sentences
    const charLimit = 280;
    let temp = '';
    sentences.forEach((sentence) => {
        if (sentence.length + temp.length <= charLimit){
            temp += ` ${sentence}.`;
        }else{
            sections.push(temp);
            temp = ` ${sentence}.`;
        }
    });
    const char = temp[temp.length-1];
    //edge case remove duplicate '.'
    if (char === '.') {
        temp = temp.substring(0, temp.length-2);
    }
    sections.push(temp);
    sendMessage(sections, tweet_id, link)
}

function formatMessageUsingWords (message) {
  let temp = ``;
  let index = 0;
  let posts = [];
  words = message.split(' ');
  while( index <= words.length ) {
    const m = words[index]
    if (m) {
      if (temp.length + m.length < 280 ) {
        temp += ` ${m}`;
        index += 1;
      }else{
        posts.push(temp);
        temp = `${m}`;
        index += 1
      }
    }else{
      index += 1
    }
  }
  posts.push(temp);
  return posts;
}
/**
 * 
 * Send message
 */

 function sendMessage (messages, tweet_id, link) {
    let posts = [];
    messages = messages.filter((message) => message.length > 1);
    //Format verses that do not have '.' to separate text into sentences;
    messages.forEach((m) => {
     if (m.length <= 280) {
       posts.push(m);
     }else{
       const tempPosts = formatMessageUsingWords(m);
       tempPosts.forEach((tm) => posts.push(tm) );
     }
    });
    //Split posts into a max of 3 threads
    if (posts.length > 3) {
      posts = posts.slice(0,3);
      posts.push(link);
    }
    //Send tweet
    var options = {
      url: 'https://biblebot-tweet-api.herokuapp.com/api/v1/status',
      body: {
        messages: posts,
        reply_to: tweet_id
      },
      json:true 
    }
    requestAPI.post(options).then( function (response) {
      console.log(response);
    }).catch(function (response) {
      console.log('There was an error');
      console.log(response);
  });
 }
/**
 * Receives Account Acitivity events
 **/
app.post('/webhook/twitter', function(request, response) {
  const body = request.body;
  if (body.direct_message_events) {
    console.log('Direct message received')
  }else if (body.tweet_create_events){
    //Get necessary details from event
    const user = body.tweet_create_events[0].user;
    const tweet_id =  body.tweet_create_events[0].id_str;
    let text = body.tweet_create_events[0].text.toLowerCase();

    let command = '';
    let start = text.search('open');
    if (start !== -1){
       command = 'open';
      } else {
      start = text.search('read');
      if (start !== -1) command = 'read';
    }
    if (start !== -1) {
      text = text.substring(start + command.length);
      let message = `Hi @${user.screen_name}, `;
      if (command.toLowerCase() === 'open' || command.toLowerCase() === 'read') {
        //Remove trailing spaces
        let passage = text.trim();
        //Add passage to return message
        message += `${passage}: `;
        //Remove whitespaces within passage
        passage = passage.replace(/\s/g, '');
        //Call Bible API for passage
        let url =  `http://getbible.net/json?passage=${passage}`;
        var request_options = {
          url: url,
          headers: {
            'User-Agent': 'Request-Promise'
          },
          json:true 
        }
        
        requestAPI.get(request_options).then( function (response) {
          response = response.substring(1, response.length-2);
          let json = JSON.parse(response);
          //Add verses to return message
          let link = `Read more here: https://www.biblegateway.com/passage/?search=${passage}&version=NKJV`;
          if ( json.type === 'verse') {
             for (verse in json.book[0].chapter) {
                message += `${verse}: ${json.book[0].chapter[verse].verse} `;
             }
          }else if (json.type === 'chapter' ) {
            for (verse in json.chapter) {
              message += `${verse}: ${json.chapter[verse].verse} `;
           }
          }
          //Remove line breaks
          message = message.replace(/(\r\n|\n|\r)/gm,"");
          //Format messages into threads
          formatMessage(message, tweet_id, link);
        }).catch(function (response) {
          //const message = `Sorry @${user.screen_name}, couldn't find that passage. Please try again using '@this_verse open luke 1:1' `;
          //formatMessage(message, tweet_id);
          console.log(response)
      });
      }else{
        //console.log('Invalid command')
      }
    }
  }
  socket.io.emit(socket.activity_event, {
    internal_id: uuid(),
    event: request.body
  })

  response.send('200 OK')
}); 

/**
 * Serves the home page
 **/
app.get('/', function(request, response) {
  response.render('index')
})


/**
 * Subscription management
 **/
app.get('/subscriptions', auth.basic, cacheRoute(1000), require('./routes/subscriptions'))


/**
 * Starts Twitter sign-in process for adding a user subscription
 **/
app.get('/subscriptions/add', passport.authenticate('twitter', {
  callbackURL: '/callbacks/addsub'
}));

/**
 * Starts Twitter sign-in process for removing a user subscription
 **/
app.get('/subscriptions/remove', passport.authenticate('twitter', {
  callbackURL: '/callbacks/removesub'
}));


/**
 * Webhook management routes
 **/
var webhook_view = require('./routes/webhook')
app.get('/webhook', auth.basic, auth.csrf, webhook_view.get_config)
app.post('/webhook/update', parseForm, auth.csrf, webhook_view.update_config)
app.post('/webhook/validate', parseForm, auth.csrf, webhook_view.validate_config)
app.post('/webhook/delete', parseForm, auth.csrf, webhook_view.delete_config)


/**
 * Activity view
 **/
app.get('/activity', auth.basic, require('./routes/activity'))


/**
 * Handles Twitter sign-in OAuth1.0a callbacks
 **/
app.get('/callbacks/:action', passport.authenticate('twitter', { failureRedirect: '/' }),
  require('./routes/sub-callbacks'))

