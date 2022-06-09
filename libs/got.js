const { CookieJar } = require('tough-cookie')
const cookieJar = new CookieJar()
const gotScrape = require('./scrape')
const gotDebug = require('./debug')

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:72.0) Gecko/20100101 Firefox/72.0'

let got = require('got').extend(gotScrape, gotDebug, {
  cookieJar,
  ignoreInvalidCookies: true,
  headers: {
    'user-agent': DEFAULT_USER_AGENT
  }
})

got.getCookieJar = function () {
  return cookieJar
}

module.exports = got
