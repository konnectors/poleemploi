const cheerio = require('cheerio')
const gotScrape = require('got').extend({
  hooks: {
    afterResponse: [
      addCheerioToResponse,
      addScrapeToResponse,
      addGetFormDataToResponse
    ]
  }
})

function addCheerioToResponse(response) {
  Object.defineProperty(response, '$', {
    get: function () {
      if (response._$) return response._$
      return (response._$ = cheerio.load(response.body))
    }
  })
  return response
}

function addGetFormDataToResponse(response) {
  response.getFormData = formSelector => parseForm(response.$, formSelector)
  return response
}

function addScrapeToResponse(response) {
  response.scrape = (...args) => {
    if (typeof args[0] !== 'string') args.unshift(response.$)
    return scrape(...args)
  }
  return response
}

function parseForm($, formSelector) {
  const form = $(formSelector).first()

  if (!form.is('form')) {
    throw new Error('INVALID_FORM')
  }

  const inputs = {}
  const arr = form.serializeArray()
  for (let input of arr) {
    inputs[input.name] = input.value
  }
  return inputs
}

function scrape($, specs, childSelector) {
  // Only one value shorthand
  if (
    typeof specs === 'string' ||
    (specs.sel && typeof specs.sel === 'string')
  ) {
    const { val } = scrape($, { val: specs })
    return val
  }

  // Several items shorthand
  if (childSelector !== undefined) {
    return Array.from(($.find || $)(childSelector)).map(e =>
      scrape($(e), specs)
    )
  }

  // Several properties "normal" case
  const res = {}
  Object.keys(specs).forEach(specName => {
    const spec = mkSpec(specs[specName])
    let data = spec.sel ? $.find(spec.sel) : $
    if (spec.index) {
      data = data.get(spec.index)
    }
    let val
    if (spec.fn) {
      val = spec.fn(data)
    } else if (spec.attr) {
      val = data.attr(spec.attr)
    } else {
      val = data
      val = val && val.text()
      val = val && val.trim()
    }
    if (spec.parse) {
      val = spec.parse(val)
    }
    res[specName] = val
  })
  return res
}

function mkSpec(spec) {
  if (typeof spec === 'string') {
    return { sel: spec }
  } else {
    return spec
  }
}

module.exports = gotScrape
