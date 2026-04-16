'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { MapPin, Loader2 } from 'lucide-react'

export interface MapPickerValue {
  lat: number
  lng: number
  radiusKm: number
  label: string
}

interface Props {
  value: MapPickerValue | null
  onChange: (value: MapPickerValue) => void
  disabled?: boolean
}

// Reverse geocoding using OpenStreetMap Nominatim (free, no API key)
async function reverseGeocode(lat: number, lng: number): Promise<string> {
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&accept-language=ja`,
      { headers: { 'User-Agent': 'auto-form/1.0' } }
    )
    if (!res.ok) return `${lat.toFixed(4)}, ${lng.toFixed(4)}`
    const data = await res.json()
    // Extract city-level name
    const addr = data.address || {}
    const parts = [
      addr.city || addr.town || addr.village || addr.municipality,
      addr.state || addr.province,
    ].filter(Boolean)
    return parts.length > 0 ? parts.join(' ') : (data.display_name?.split(',')[0] || `${lat.toFixed(4)}, ${lng.toFixed(4)}`)
  } catch {
    return `${lat.toFixed(4)}, ${lng.toFixed(4)}`
  }
}

// SVG pin icon (avoids Leaflet image path issues in Next.js)
const PIN_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 40" width="24" height="40">
  <path d="M12 0C5.37 0 0 5.37 0 12c0 9 12 28 12 28S24 21 24 12C24 5.37 18.63 0 12 0z" fill="#3B82F6" stroke="white" stroke-width="1.5"/>
  <circle cx="12" cy="12" r="5" fill="white"/>
</svg>`

export default function MapPicker({ value, onChange, disabled = false }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<import('leaflet').Map | null>(null)
  const markerRef = useRef<import('leaflet').Marker | null>(null)
  const circleRef = useRef<import('leaflet').Circle | null>(null)
  const [radiusKm, setRadiusKm] = useState(value?.radiusKm ?? 10)
  const [geocoding, setGeocoding] = useState(false)
  const [locationName, setLocationName] = useState(value?.label ?? '')

  const updateCircle = useCallback((lat: number, lng: number, km: number) => {
    if (!mapRef.current) return
    import('leaflet').then((L) => {
      if (circleRef.current) circleRef.current.remove()
      circleRef.current = L.circle([lat, lng], {
        radius: km * 1000,
        color: '#3B82F6',
        fillColor: '#3B82F6',
        fillOpacity: 0.1,
        weight: 2,
      }).addTo(mapRef.current!)
    })
  }, [])

  const handleMapClick = useCallback(async (lat: number, lng: number, km: number) => {
    if (disabled) return
    import('leaflet').then((L) => {
      if (markerRef.current) markerRef.current.remove()
      const icon = L.divIcon({
        className: '',
        html: PIN_SVG,
        iconSize: [24, 40],
        iconAnchor: [12, 40],
      })
      markerRef.current = L.marker([lat, lng], { icon }).addTo(mapRef.current!)
    })
    updateCircle(lat, lng, km)
    setGeocoding(true)
    const label = await reverseGeocode(lat, lng)
    setLocationName(label)
    setGeocoding(false)
    onChange({ lat, lng, radiusKm: km, label })
  }, [disabled, updateCircle, onChange])

  // Initialize map
  useEffect(() => {
    if (!containerRef.current) return
    let cancelled = false

    import('leaflet').then((L) => {
      // Abort if cleanup already ran (React StrictMode double-mount)
      if (cancelled || !containerRef.current) return
      // Guard against double initialization (shouldn't happen, but be safe)
      if ((containerRef.current as unknown as Record<string, unknown>)._leaflet_id) return

      // Inject Leaflet CSS once
      if (!document.getElementById('leaflet-css')) {
        const link = document.createElement('link')
        link.id = 'leaflet-css'
        link.rel = 'stylesheet'
        link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css'
        document.head.appendChild(link)
      }

      const map = L.map(containerRef.current, {
        center: [36.2048, 138.2529], // Japan center
        zoom: 5,
        zoomControl: true,
      })

      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        maxZoom: 18,
      }).addTo(map)

      map.on('click', (e: import('leaflet').LeafletMouseEvent) => {
        if (disabled) return
        handleMapClick(e.latlng.lat, e.latlng.lng, radiusKm)
      })

      mapRef.current = map

      // Restore existing value
      if (value) {
        const icon = L.divIcon({
          className: '',
          html: PIN_SVG,
          iconSize: [24, 40],
          iconAnchor: [12, 40],
        })
        markerRef.current = L.marker([value.lat, value.lng], { icon }).addTo(map)
        circleRef.current = L.circle([value.lat, value.lng], {
          radius: value.radiusKm * 1000,
          color: '#3B82F6',
          fillColor: '#3B82F6',
          fillOpacity: 0.1,
          weight: 2,
        }).addTo(map)
        map.setView([value.lat, value.lng], 10)
      }
    })

    return () => {
      cancelled = true
      if (mapRef.current) {
        mapRef.current.remove()
        mapRef.current = null
        markerRef.current = null
        circleRef.current = null
      }
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Update map click handler when radiusKm or disabled changes
  useEffect(() => {
    if (!mapRef.current) return
    mapRef.current.off('click')
    if (!disabled) {
      mapRef.current.on('click', (e: import('leaflet').LeafletMouseEvent) => {
        handleMapClick(e.latlng.lat, e.latlng.lng, radiusKm)
      })
    }
  }, [radiusKm, disabled, handleMapClick])

  const handleRadiusChange = (km: number) => {
    setRadiusKm(km)
    if (value) {
      updateCircle(value.lat, value.lng, km)
      onChange({ ...value, radiusKm: km })
    }
  }

  return (
    <div className="space-y-2">
      {/* Map container */}
      <div className="relative rounded border border-gray-300 overflow-hidden">
        <div
          ref={containerRef}
          style={{ height: 280 }}
          className={disabled ? 'opacity-60 pointer-events-none' : ''}
        />
        {!value && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="bg-white/90 rounded px-3 py-1.5 text-xs text-gray-500 flex items-center gap-1.5 shadow">
              <MapPin className="w-3.5 h-3.5 text-blue-500" />
              地図をクリックして調査中心地を指定
            </div>
          </div>
        )}
      </div>

      {/* Radius control */}
      <div className="flex items-center gap-3">
        <label className="text-xs text-gray-500 flex-shrink-0 w-16">範囲半径</label>
        <input
          type="range"
          min={1}
          max={100}
          step={1}
          value={radiusKm}
          onChange={(e) => handleRadiusChange(Number(e.target.value))}
          disabled={disabled}
          className="flex-1 accent-blue-500"
        />
        <span className="text-xs text-gray-700 font-medium w-12 text-right">{radiusKm} km</span>
      </div>

      {/* Selected location info */}
      {value && (
        <div className="flex items-center gap-2 bg-blue-50 border border-blue-200 rounded px-3 py-2">
          <MapPin className="w-3.5 h-3.5 text-blue-500 flex-shrink-0" />
          <div className="flex-1 min-w-0">
            {geocoding ? (
              <span className="text-xs text-blue-600 flex items-center gap-1">
                <Loader2 className="w-3 h-3 animate-spin" /> 位置情報取得中...
              </span>
            ) : (
              <span className="text-xs text-blue-700 font-medium truncate block">
                {locationName || `${value.lat.toFixed(4)}, ${value.lng.toFixed(4)}`}
              </span>
            )}
            <span className="text-xs text-blue-400">
              {value.lat.toFixed(4)}, {value.lng.toFixed(4)} / 半径 {value.radiusKm}km
            </span>
          </div>
        </div>
      )}
    </div>
  )
}
