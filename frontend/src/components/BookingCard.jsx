import { useState } from 'react'
import {
  formatDate, formatTime, formatDateTime, formatMoney, timeHeld, agencyName,
  levelName, raceName, sexName, formatHeight, bookingStart, releaseTime
} from '../format'

export default function BookingCard({ entry }) {
  const [open, setOpen] = useState(false)

  const isReleased = entry.status === 'released'
  const held = isReleased ? timeHeld(bookingStart(entry), entry.releasedAt) : null
  // The roster gives a booking date only; show when we first saw them for new bookings.
  const seen = !entry.baseline && !entry.fromReleaseList && entry.firstSeen ? ` (seen ${formatTime(entry.firstSeen)})` : ''

  return (
    <div className={`card ${isReleased ? 'card-released' : 'card-custody'}`}>
      <div className="card-header" onClick={() => setOpen(!open)}>
        <div className="card-left">
          <div className="card-name">{entry.name}</div>
          <div className="card-meta">
            Booking #{entry.id} &nbsp;·&nbsp; Booked: {entry.bookedAt ? formatDate(entry.bookedAt) : 'N/A'}{seen}
            {held && <span className="card-time-held"> &nbsp;·&nbsp; Held: {held}</span>}
          </div>
        </div>
        <div className="card-right">
          <span className={`badge ${isReleased ? 'badge-released' : 'badge-custody'}`}>
            {isReleased ? 'Released' : 'In Custody'}
          </span>
          <span className="card-toggle">{open ? '▲' : '▼'}</span>
        </div>
      </div>

      {open && (
        <div className="card-body">
          {isReleased && entry.releasedAt && (
            <div className="card-release-row">
              Released: {releaseTime(entry, formatDateTime)}
              {held && <span className="card-time-held-detail"> &nbsp;·&nbsp; Time held: {held}</span>}
            </div>
          )}
          {entry.fromReleaseList && (
            <div className="card-release-row">
              Booked and released between our checks — taken from the jail's release list.
            </div>
          )}
          {!isReleased && entry.schedRelease && (
            <div className="card-release-row">Scheduled release: {formatDate(entry.schedRelease)}</div>
          )}

          <div className="card-description">
            <div className="desc-row"><span>Age</span><span>{entry.age || 'N/A'}</span></div>
            <div className="desc-row"><span>Sex</span><span>{sexName(entry.sex)}</span></div>
            <div className="desc-row"><span>Race</span><span>{raceName(entry.race)}</span></div>
            <div className="desc-row"><span>Height</span><span>{formatHeight(entry.height)}</span></div>
            <div className="desc-row"><span>Weight</span><span>{entry.weight ? `${entry.weight} lbs` : 'N/A'}</span></div>
            <div className="desc-row"><span>Arresting Agency</span><span>{agencyName(entry.arrestingAgency)}</span></div>
            <div className="desc-row"><span>Total Bond</span><span>{formatMoney(entry.bondTotal) || 'None'}</span></div>
          </div>

          {entry.charges?.length > 0 && (
            <div className="card-charges">
              <div className="charges-title">Charges ({entry.charges.length})</div>
              {entry.charges.map((c, i) => (
                <div key={i} className="charge-row">
                  <div className="charge-violation">
                    {c.violation}
                    {c.level && <span className="charge-add-desc"> — {levelName(c.level)}</span>}
                    {c.cleared && <span className="charge-cleared"> ✓ Cleared</span>}
                  </div>
                  {c.clearance && <div className="charge-clearance">Clearance: {c.clearance}</div>}
                  {(c.bondBailType || c.bondAmount || c.cashAmount) && (
                    <div className="charge-bail">
                      Bond: {[c.bondBailType, formatMoney(c.bondAmount), c.cashAmount ? `cash ${formatMoney(c.cashAmount)}` : null].filter(Boolean).join(' · ')}
                    </div>
                  )}
                  {c.nextCourtDate && <div className="charge-court">Next court: {formatDate(c.nextCourtDate)}</div>}
                  {c.arrestAgency && <div className="charge-agency">Arrested by: {agencyName(c.arrestAgency)}</div>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
