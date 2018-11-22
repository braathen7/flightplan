const jspath = require('jspath')
const moment = require('moment-timezone')

const Award = require('../../Award')
const Flight = require('../../Flight')
const Parser = require('../../Parser')
const Segment = require('../../Segment')
const { cabins } = require('../../consts')
const { aircraft } = require('../../data')
const utils = require('../../utils')

// Cabin codes
const cabinCodes = {
  'E': cabins.economy,
  'R': cabins.economy,
  'N': cabins.premium,
  'B': cabins.business,
  'F': cabins.first
}

// Cabin and tier to fare code mapping
const tierId = { STD: 'S', PT1: '1', PT2A: '2' }
const cabinId = { ECO: 'Y', PEY: 'W', BUS: 'C', FIR: 'F' }

// Order of cabins from best to worst
const cabinOrder = [ cabins.first, cabins.business, cabins.premium, cabins.economy ]

module.exports = class extends Parser {
  parse (results) {
    const json = results.contents('json', 'results')

    // Get airport codes
    const airports = this.airportCodes(json)

    // Get mileage info
    const { milesInfo } = json

    // Get flights
    const { engine } = results
    const flightData = jspath.apply(`.pageBom.modelObject.availabilities.upsell.bounds.flights`, json)
    const flights = flightData.map(f => {
      const { flightIdString } = f

      // Determine availability
      const availability = this.availabilityMap(f)
      if (availability.size === 0) {
        return null
      }

      // Build list of segments for this flight
      const segments = f.segments.map(x => {
        const flightId = x.flightIdentifier
        const airline = flightId.marketingAirline
        const fromCity = airports.get(x.originLocation)
        const toCity = airports.get(x.destinationLocation)

        // Calculate departure / arrival times
        const departure = moment.utc(flightId.originDate)
        const arrival = moment.utc(x.destinationDate)

        // Return the segment
        return new Segment({
          airline,
          flight: `${airline}${flightId.flightNumber}`,
          aircraft: this.findAircraft(x.equipment),
          fromCity,
          toCity,
          date: departure,
          departure: departure,
          arrival: arrival,
          stops: parseInt(x.numberOfStops),
          lagDays: utils.daysBetween(departure, arrival)
        })
      })

      // Determine partner status
      const partner = this.isPartner(segments, [ 'KA' ])

      // Parse fare info from the flight ID string
      const fare = this.parseFare(flightIdString)
      const data = availability.get(fare.cabin)
      if (!data || isNaN(data.quantity)) {
        return
      }

      // Get mileage cost
      if (milesInfo) {
        const val = milesInfo[flightIdString]
        if (val && val > 0) {
          data.mileageCost = val
        }
      }

      // Create the award, and return the flight
      return new Flight(segments, [
        new Award({
          engine,
          partner,
          fare,
          ...data
        })
      ])
    }).filter(x => !!x)

    // Return results
    return flights
  }

  findAircraft (equipment) {
    const result = aircraft.find(x => x.iata === equipment)
    return result ? result.icao : equipment
  }

  availabilityMap (flight) {
    const { segments } = flight

    // Validate the flight info first
    if (segments.length === 0) {
      throw new Error(`Empty segments on flight: ${flight}`)
    }
    for (const segment of segments) {
      if (segment.cabins.E && segment.cabins.R) {
        throw new Error(`Conflicting cabin status: ${segment}`)
      }
    }

    // Transform the per-segment availability
    const availability = segments.map(segment => {
      const obj = {}
      jspath.apply(`.cabins.*`, segment).forEach(x => {
        obj[cabinCodes[x.code]] = x.status
      })
      return obj
    })

    // Create a cabin-to-segment mapping, for each possible cabin
    const map = new Map()
    for (const cabin of cabinOrder) {
      const mapping = this.cabinAvailability(availability, cabin)
      if (mapping) {
        map.set(cabin, mapping)
      }
    }
    return map
  }

  cabinAvailability (availability, cabin) {
    const ordering = [ cabins.premium, cabins.economy ].includes(cabin)
      ? [ cabin ]
      : cabinOrder.slice(cabinOrder.indexOf(cabin))
    const values = []
    const cabinList = []
    for (const segment of availability) {
      // Search from our cabin, to lower levels of service, until we find something
      const segmentCabin = ordering.find(x => x in segment)
      if (!segmentCabin) {
        return null // No availability for this segment
      }
      values.push(segment[segmentCabin])
      cabinList.push(segmentCabin)
    }

    // If no availability for this cabin, move on
    if (values.includes('N') || values.includes('X') || !cabinList.includes(cabin)) {
      return null // No availability
    }

    // Check for waitlisted awards
    if (values.includes('L')) {
      const quantity = this.query.quantity
      return { cabins: cabinList, quantity, exact: false, waitlisted: true }
    }

    // Compute numerical quantity
    const quantity = Math.min(...values.map(x => parseInt(x)))
    return { cabins: cabinList, quantity, exact: true, waitlisted: false }
  }

  parseFare (str) {
    const [ tier, cabin ] = str.split('_').slice(-2)
    const code = cabinId[cabin] + tierId[tier]
    const fare = this.config.fares.find(x => x.code === code)
    if (!fare) {
      throw new Parser.Error(`Failed to parse fare from: ${str}`)
    }
    return fare
  }

  airportCodes (json) {
    const map = new Map()
    const classNames = jspath.apply(`.pageBom.dictionaries.classNameDictionary`, json)[0]
    const locationIdx = Object.entries(classNames).find(x => x[1] === 'CXLocation')[0]
    const dict = jspath.apply(`.pageBom.dictionaries.values."${locationIdx}".*`, json)

    // Add airports
    jspath.apply(`.{.type === "A"}`, dict).forEach(entry => {
      map.set(entry.dictionaryKey, entry.code)
    })

    // Add terminals
    jspath.apply(`.{.type === "T"}`, dict).forEach(entry => {
      const parent = dict.find(x => x.dictionaryKey === entry.parent)
      map.set(entry.dictionaryKey, parent.code)
    })

    return map
  }
}
