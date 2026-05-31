// Configuración Inicial de Tokens
mapboxgl.accessToken = 'pk.eyJ1Ijoic2ViYXN0MjEiLCJhIjoiY21wcHRpdDV3MGoxZTJycTZsbXhjaXY3ZyJ9.Orx8pP8h7z0D4KjSlXyBoQ';

// 1. Inicializar el Mapa de Mapbox (Cambiado a Light Premium según tu diseño preferido)
const map = new mapboxgl.Map({
    container: 'map',
    style: 'mapbox://styles/mapbox/light-v11', 
    center: [-118.24368, 34.05223], 
    zoom: 5
});

// 2. Sistema de navegación por pestañas para el móvil
const btnLista = document.getElementById('nav-lista');
const btnMapa = document.getElementById('nav-mapa');
const tabLista = document.getElementById('tab-lista');
const tabMapa = document.getElementById('tab-mapa');

if (btnLista && btnMapa) {
    btnLista.addEventListener('click', () => {
        cambiarPestana(btnLista, btnMapa, tabLista, tabMapa);
    });

    btnMapa.addEventListener('click', () => {
        cambiarPestana(btnMapa, btnLista, tabMapa, tabLista);
        setTimeout(() => map.resize(), 100); 
    });
}

function cambiarPestana(activaBtn, inactivaBtn, activaTab, inactivaTab) {
    if (!activaBtn || !inactivaBtn || !activaTab || !inactivaTab) {
        console.warn("Advertencia: Uno de los elementos de las pestañas no se encontró en el DOM.");
        return; 
    }

    activaBtn.classList.remove('text-slate-400');
    activaBtn.classList.add('text-blue-600', 'font-bold');

    inactivaBtn.classList.remove('text-blue-600', 'font-bold');
    inactivaBtn.classList.add('text-slate-400');

    activaTab.classList.add('active');
    inactivaTab.classList.remove('active');
}

// Variable global para almacenar marcadores activos
let marcadoresRuta = [];

// 3. Lógica de Enrutamiento con VROOM en Railway + Parseo de Tabuladores (Excel/Sheets)
document.getElementById('btn-optimizar').addEventListener('click', async () => {
    const btn = document.getElementById('btn-optimizar');
    if (btn.disabled) return; 

    const texto = document.getElementById('input-direcciones').value.trim();
    if (!texto) return alert("Por favor, introduce la lista de datos.");

    const lineas = texto.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    if (lineas.length < 2) return alert("Se necesitan al menos 2 registros para trazar la ruta.");

    btn.disabled = true;
    btn.innerText = "🔍 Procesando y Geocodificando...";

    let paradas = [];

    // --- PASO 1: PARSEAR TABULADORES Y GEOCODIFICAR ---
    for (let i = 0; i < lineas.length; i++) {
        const lineaCompleta = lineas[i];
        const partes = lineaCompleta.split(/\t+/).map(p => p.trim());
        const columnas = partes.length >= 4 ? partes : lineaCompleta.split(/ {2,}/).map(p => p.trim());

        const numeroOrden   = columnas[0] || (i + 1);
        const direccionRaw  = columnas[1] || "";
        const paqueteId     = columnas[2] || "N/A";
        const nombreCliente = columnas[3] || "Cliente No Especificado";

        if (!direccionRaw) {
            console.warn(`Línea ${i + 1} ignorada: Falta el campo de dirección.`);
            continue;
        }

        try {
            const urlGeocode = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(direccionRaw)}.json?access_token=${mapboxgl.accessToken}&limit=1`;
            const respuestaGeocode = await fetch(urlGeocode);
            if (!respuestaGeocode.ok) throw new Error("Error en geocodificación");
            
            const datosGeocode = await respuestaGeocode.json();
            
            if (datosGeocode.features && datosGeocode.features.length > 0) {
                const [lng, lat] = datosGeocode.features[0].center;
                
                paradas.push({
                    lng: lng,
                    lat: lat,
                    numero: numeroOrden,
                    direccionOficial: datosGeocode.features[0].place_name,
                    paquete: paqueteId,
                    cliente: nombreCliente
                });
            } else {
                btn.disabled = false;
                btn.innerText = "⚡ Convertir y Optimizar Ruta";
                return alert(`No se encontró ubicación para la dirección: "${direccionRaw}"`);
            }
        } catch (errorGeocode) {
            console.error(errorGeocode);
            btn.disabled = false;
            btn.innerText = "⚡ Convertir y Optimizar Ruta";
            return alert(`Error técnico al procesar la dirección de la fila: ${numeroOrden}`);
        }
    }

    // --- PASO 2: OBTENER EXTREMOS Y LIMPIAR DUPLICADOS ---
    const startInput = document.getElementById('start-coords').value.trim().split(',');
    const endInput = document.getElementById('end-coords').value.trim().split(',');

    const startPoint = { lng: parseFloat(startInput[0]), lat: parseFloat(startInput[1]), numero: "START", cliente: "📍 Punto de Partida", paquete: "INICIO VIAJE" };
    const endPoint = { lng: parseFloat(endInput[0]), lat: parseFloat(endInput[1]), numero: "END", cliente: "🏁 Punto de Destino", paquete: "FIN VIAJE" };

    let paradasFiltro = paradas.filter((parada, index) => {
        if (index === 0) return true;
        const ant = paradas[index - 1];
        return !(parada.lng === ant.lng && parada.lat === ant.lat);
    });

    // --- PASO 3: SOLICITAR OPTIMIZACIÓN LOGÍSTICA A VROOM EN CLOUD (RAILWAY) ---
    btn.innerText = "⏳ Optimizando más de 100 paradas en la nube...";

    // Estructuramos los "jobs" exactamente como lo espera el JSON limpio de VROOM
    const jobsVroom = paradasFiltro.map((parada, index) => ({
        id: index, 
        location: [parada.lng, parada.lat]
    }));

    // Construimos el cuerpo idéntico al payload exitoso de tu Postman
    const cuerpoPeticionVroom = {
        vehicles: [
            {
                id: 0,
                profile: "driving", // El perfil correcto que acepta OSRM público
                start: [startPoint.lng, startPoint.lat],
                end: [endPoint.lng, endPoint.lat]
            }
        ],
        jobs: jobsVroom
    };

    let paradasOptimizadas = [];
    let viajeDataTrip = { distance: 0, duration: 0 };
    let exitoVroom = false;

    try {
        const respuestaVroom = await fetch('https://vroom-railway-production-06c2.up.railway.app/optimize', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(cuerpoPeticionVroom)
        });

        const resultadoVroom = await respuestaVroom.json();

        if (respuestaVroom.ok && resultadoVroom.code === 0 && resultadoVroom.routes && resultadoVroom.routes.length > 0) {
            const pasosRuta = resultadoVroom.routes[0].steps;
            
            // Recopilar estadísticas de entrega calculadas
            viajeDataTrip.distance = resultadoVroom.routes[0].distance;
            viajeDataTrip.duration = resultadoVroom.routes[0].duration;

            // Reconstruir el itinerario en el orden secuencial estricto dictado por VROOM
            pasosRuta.forEach(paso => {
                if (paso.type === 'job') {
                    const paradaOriginal = paradasFiltro[paso.id];
                    if (paradaOriginal) paradasOptimizadas.push(paradaOriginal);
                }
            });
            exitoVroom = true;
        }
    } catch (errorVroom) {
        console.error("Fallo el motor VROOM en la nube, activando plan de contingencia Manhattan...", errorVroom);
    }

    // --- PLAN B: Contingencia local si el servidor VROOM experimenta caídas ---
    if (!exitoVroom) {
        let paradasPorBloque = [];
        let copiaExcel = [...paradasFiltro];
        let puntoActual = startPoint;

        while (copiaExcel.length > 0) {
            let indiceMasCercano = 0;
            let distanciaMinima = Infinity;
            for (let i = 0; i < copiaExcel.length; i++) {
                let dist = Math.abs(puntoActual.lng - copiaExcel[i].lng) + Math.abs(puntoActual.lat - copiaExcel[i].lat);
                if (dist < distanciaMinima) {
                    distanciaMinima = dist;
                    indiceMasCercano = i;
                }
            }
            let paradaSiguiente = copiaExcel.splice(indiceMasCercano, 1)[0];
            paradasPorBloque.push(paradaSiguiente);
            puntoActual = paradaSiguiente;
        }
        paradasOptimizadas = [...paradasPorBloque];
    }

    // --- PASO 4: RESCATE Y REINYECCIÓN DE MULTI-ENTREGAS (MISMO EDIFICIO) ---
    let paradasFaltantes = paradas.filter(pOriginal => {
        return !paradasOptimizadas.some(pO => String(pO.numero) === String(pOriginal.numero));
    });

    if (paradasFaltantes.length > 0) {
        paradasFaltantes.forEach(pf => {
            const idxAsociado = paradasOptimizadas.findIndex(pO => Math.abs(pO.lng - pf.lng) < 0.0001 && Math.abs(pO.lat - pf.lat) < 0.0001);
            if (idxAsociado !== -1) {
                paradasOptimizadas.splice(idxAsociado + 1, 0, pf);
            } else {
                paradasOptimizadas.push(pf);
            }
        });
    }

    // Asegurar sándwich perfecto limpio de START/END residuales
    paradasOptimizadas = paradasOptimizadas.filter(p => String(p.numero) !== "START" && String(p.numero) !== "END");
    paradasOptimizadas.unshift(startPoint);
    paradasOptimizadas.push(endPoint);

    // --- PASO 5: TRAZADO DE LÍNEA EN SUB-TRAMOS SEGUROS PARA 100+ PUNTOS ---
    btn.innerText = "🗺️ Dibujando trazado de calles en el mapa...";
    let coordenadasLineaCompleta = [];

    for (let i = 0; i < paradasOptimizadas.length - 1; i += 19) {
        const segmento = paradasOptimizadas.slice(i, i + 20);
        if (segmento.length < 2) break;

        const chainSegmento = segmento.map(p => `${p.lng},${p.lat}`).join(';');
        const urlRoute = `https://map-production-c2c6.up.railway.app/route/v1/driving/${chainSegmento}?overview=full&geometries=geojson`;

        try {
            const res = await fetch(urlRoute);
            const dataRoute = await res.json();
            if (dataRoute.code === "Ok" && dataRoute.routes && dataRoute.routes[0]) {
                coordenadasLineaCompleta.push(...dataRoute.routes[0].geometry.coordinates);
                if (!exitoVroom) {
                    viajeDataTrip.distance += dataRoute.routes[0].distance;
                    viajeDataTrip.duration += dataRoute.routes[0].duration;
                }
            }
        } catch (e) {
            console.warn("Subsegmento de línea omitido por tramo técnico", e);
        }
    }

    if (coordenadasLineaCompleta.length > 0) {
        const geojson = {
            "type": "Feature",
            "geometry": { "type": "LineString", "coordinates": coordenadasLineaCompleta }
        };
        if (map.getSource('route')) {
            map.getSource('route').setData(geojson);
        } else {
            map.addSource('route', { 'type': 'geojson', 'data': geojson });
            map.addLayer({
                'id': 'route',
                'type': 'line',
                'source': 'route',
                'paint': { 'line-color': '#2563eb', 'line-width': 4.5, 'line-opacity': 0.85 }
            });
        }
        
        const bounds = coordenadasLineaCompleta.reduce((acc, coord) => acc.extend(coord), new mapboxgl.LngLatBounds(coordenadasLineaCompleta[0], coordenadasLineaCompleta[0]));
        map.fitBounds(bounds, { padding: 40 });
    }

    console.log(`🚀 Renderizando lote final de entrega. Total paradas en interfaz: ${paradasOptimizadas.length}`);
    renderizarRutaOSRM(viajeDataTrip, paradasOptimizadas);
    
    btn.disabled = false;
    btn.innerText = "⚡ Convertir y Optimizar Ruta";
});

// 4. Renderizar resultados optimizados en pantalla y mapa (Estilo Clean Light Premium)
function renderizarRutaOSRM(osrmTripData, paradasOrdenadas) {
    const listaUl = document.getElementById('lista-ordenada');
    if (listaUl) listaUl.innerHTML = ''; 

    if (typeof marcadoresRuta !== 'undefined' && marcadoresRuta.length > 0) {
        marcadoresRuta.forEach(marker => marker.remove());
        marcadoresRuta = [];
    } else {
        window.marcadoresRuta = [];
    }

    const diccionarioMarcadores = {};

    const contenedorStats = document.getElementById('stats-ruta');
    const txtTiempo = document.getElementById('stat-tiempo');
    const txtMillas = document.getElementById('stat-millas');

    if (contenedorStats && txtTiempo && txtMillas && osrmTripData) {
        const millas = (osrmTripData.distance * 0.000621371).toFixed(1);
        const totalMinutos = Math.round(osrmTripData.duration / 60);
        const textoDuracion = totalMinutos >= 60 ? `${Math.floor(totalMinutos / 60)}h ${totalMinutos % 60}m` : `${totalMinutos} min`;
        
        txtTiempo.innerText = textoDuracion;
        txtMillas.innerText = `${millas} mi`;
        contenedorStats.classList.remove('hidden');
    }

    let contadorEntregas = 0;
    const mapaBurbujas = {};

    paradasOrdenadas.forEach((parada) => {
        if (!parada || String(parada.numero) === "START" || String(parada.numero) === "END") return;
        const claveCoord = `${parseFloat(parada.lng).toFixed(5)}_${parseFloat(parada.lat).toFixed(5)}`;
        if (!mapaBurbujas[claveCoord]) {
            mapaBurbujas[claveCoord] = [];
        }
        mapaBurbujas[claveCoord].push({
            numExcel: parada.numero,
            idPaquete: parada.paquete || "N/A",
            nomCliente: parada.cliente || "Cliente Sin Nombre",
            direccion: parada.direccionOficial || parada.direccion || "Dirección no disponible"
        });
    });

    paradasOrdenadas.forEach((parada, idx) => {
        if (!parada) return; 

        const esInicio = String(parada.numero) === "START";
        const esFin = String(parada.numero) === "END";
        
        let colorBorde = "border-emerald-500"; 
        let badgeClase = "bg-emerald-50 text-emerald-700 border border-emerald-100"; 
        let colorPin = "#059669"; 
        let textoOrdenVisual = "";
        let esMultiEntrega = false;
        let claveCoordActual = "";

        if (esInicio) {
            colorBorde = "border-blue-500";
            badgeClase = "bg-blue-50 text-blue-600 border border-blue-100";
            colorPin = "#2563eb"; 
            textoOrdenVisual = "🛫 Salida";
        } else if (esFin) {
            colorBorde = "border-purple-500";
            badgeClase = "bg-purple-50 text-purple-600 border border-purple-100";
            colorPin = "#7c3aed"; 
            textoOrdenVisual = "🏁 Fin";
        } else {
            contadorEntregas++;
            textoOrdenVisual = contadorEntregas;

            claveCoordActual = `${parseFloat(parada.lng).toFixed(5)}_${parseFloat(parada.lat).toFixed(5)}`;
            const paquetesEnEstaDireccion = mapaBurbujas[claveCoordActual] || [];

            if (paquetesEnEstaDireccion.length >= 2) {
                esMultiEntrega = true;
                colorBorde = "border-amber-500";
                badgeClase = "bg-amber-50 text-amber-700 border border-amber-200";
                colorPin = "#d97706"; 
            }

            if ((contadorEntregas - 1) % 10 === 0) {
                const entregasSolo = paradasOrdenadas.filter(p => String(p.numero) !== "START" && String(p.numero) !== "END");
                const entregasLote = entregasSolo.slice(contadorEntregas - 1, contadorEntregas - 1 + 10);
                
                const direccionesLimpias = entregasLote.map(p => {
                    let texto = p.direccionOficial || p.direccion || "Direccion Desconocida";
                    texto = texto.replace(/,?\s*united states\s*$/gi, '').replace(/,?\s*usa\s*$/gi, '').replace(/,/g, '');
                    return encodeURIComponent(texto).replace(/%20/g, '+');
                });

                const destinoApple = direccionesLimpias[direccionesLimpias.length - 1];
                const waypointsApple = direccionesLimpias.slice(0, -1).map(dir => `waypoint=${dir}`).join('&');
                const urlAppleMaps = `maps://maps.apple.com/directions?mode=driving&origin=Current+Location&destination=${destinoApple}${waypointsApple ? '&' + waypointsApple : ''}`;

                const primerDestinoGoogle = direccionesLimpias[0];
                const paradasExtrasGoogle = direccionesLimpias.slice(1).join('|');
                const urlGoogleMaps = `google.navigation:q=${primerDestinoGoogle}&waypoints=${paradasExtrasGoogle}&mode=d`;
                
                const numeroLote = Math.floor((contadorEntregas - 1) / 10) + 1;
                const entregaFin = (contadorEntregas - 1) + entregasLote.length;

                const liGrupo = document.createElement('li');
                liGrupo.className = "bg-white p-4 rounded-xl border border-slate-100 mt-4 mb-3 shadow-sm relative overflow-hidden flex flex-col gap-3";
                liGrupo.innerHTML = `
                    <div class="absolute left-0 top-0 bottom-0 w-1 bg-gradient-to-b from-blue-500 to-emerald-500"></div>
                    <div class="flex justify-between items-center pl-2">
                        <span class="text-slate-800 font-bold text-xs uppercase tracking-wide">📦 Lote de Ruta ${numeroLote}</span>
                        <span class="text-[10px] bg-slate-50 text-slate-500 border border-slate-100 px-2 py-0.5 rounded-md font-mono">
                            Paradas ${contadorEntregas} a ${entregaFin}
                        </span>
                    </div>
                    <div class="flex gap-2 w-full">
                        <a href="${urlAppleMaps}" target="_blank" class="flex-1 bg-blue-50 hover:bg-blue-100 text-blue-600 font-bold py-2.5 rounded-lg transition text-xs text-center stop-propagation no-underline">🧭 Apple Maps</a>
                        <a href="${urlGoogleMaps}" class="flex-1 bg-emerald-50 hover:bg-emerald-100 text-emerald-700 font-bold py-2.5 rounded-lg transition text-xs text-center stop-propagation no-underline">🗺️ Google Maps</a>
                    </div>
                `;
                if (listaUl) listaUl.appendChild(liGrupo);
            }
        }
        
        const numExcel = parada.numero || idx;
        const idPaquete = parada.paquete || "N/A";
        const nomCliente = parada.cliente || "Cliente Sin Nombre";
        const dirOficial = parada.direccionOficial || parada.direccion || "Dirección no disponible";

        const li = document.createElement('li');
        li.className = `flex justify-between items-center bg-white p-4 rounded-xl border-l-4 ${colorBorde} border-t border-r border-b border-slate-100 shadow-sm hover:bg-slate-50/60 transition cursor-pointer mb-2 select-none`;
        
        const claseTextoOrden = colorPin === "#d97706" ? "text-amber-600" : esInicio ? "text-blue-600" : esFin ? "text-purple-600" : "text-emerald-600";

        li.innerHTML = `
            <div class="flex-1 min-w-0 pr-3 flex flex-col gap-0.5">
                <div class="flex flex-wrap items-center gap-1.5 mb-1">
                    ${!esInicio && !esFin ? `<span class="text-[10px] font-bold px-2 py-0.5 rounded-md tracking-wide ${badgeClase}">Fila: #${numExcel}</span>` : ''}
                    <span class="text-xs font-bold font-mono tracking-wide ${claseTextoOrden}">
                        ${esInicio || esFin ? textoOrdenVisual : `📍 Parada #${textoOrdenVisual}`}
                    </span>
                </div>
                <span class="text-sm font-bold text-slate-900 tracking-tight truncate">👤 ${nomCliente}</span>
                <span class="text-[11px] text-slate-500 font-medium truncate">📍 ${dirOficial}</span>
                ${!esInicio && !esFin ? `<div class="text-[10px] font-medium text-slate-400 mt-0.5">ID Paquete: <span class="text-slate-600 font-mono font-semibold">${idPaquete}</span></div>` : ''}
            </div>
            <a href="https://www.google.com/maps/search/?api=1&query=${parada.lat},${parada.lng}" target="_blank" 
               class="bg-slate-900 hover:bg-slate-800 text-white text-xs px-3 py-2 rounded-lg font-semibold transition shrink-0 h-fit stop-propagation no-underline active:scale-95">
                Individual
            </a>
        `;

        li.addEventListener('click', (e) => {
            if (e.target.closest('.stop-propagation')) return;
            // 1. Cambiar forzosamente a la pestaña del mapa
        const botonPestañaMapa = document.getElementById('nav-mapa');
        if (botonPestañaMapa) botonPestañaMapa.click();

        // 2. Darle tiempo al DOM para mostrarse, hacer resize, y ENTONCES enfocar la línea
        setTimeout(() => {
            map.resize();
            const bounds = coordenadasLineaCompleta.reduce((acc, coord) => acc.extend(coord), new mapboxgl.LngLatBounds(coordenadasLineaCompleta[0], coordenadasLineaCompleta[0]));
            map.fitBounds(bounds, { padding: 40 });
        }, 150);
    }
        });

        if (listaUl) listaUl.appendChild(li);

        let claveDiccionario = esInicio ? "START" : esFin ? "END" : `${parseFloat(parada.lng).toFixed(5)}_${parseFloat(parada.lat).toFixed(5)}`;
        
        if (!esInicio && !esFin) {
            const yaExisteMarcador = marcadoresRuta.some(m => {
                const coord = m.getLngLat();
                return coord.lng.toFixed(5) === parseFloat(parada.lng).toFixed(5) && coord.lat.toFixed(5) === parseFloat(parada.lat).toFixed(5);
            });
            if (yaExisteMarcador) return; 
        }

        const el = document.createElement('div');
        el.className = 'custom-marker';
        el.style.backgroundColor = colorPin;
        el.style.width = esInicio || esFin ? '32px' : '26px'; 
        el.style.height = esInicio || esFin ? '26px' : '26px';
        el.style.borderRadius = '50%';
        el.style.border = '2.5px solid #ffffff';
        el.style.display = 'flex';
        el.style.alignItems = 'center';
        el.style.justifyContent = 'center';
        el.style.color = '#ffffff'; 
        el.style.fontSize = esInicio || esFin ? '10px' : '11px';
        el.style.fontWeight = '700';
        el.style.boxShadow = '0 4px 8px rgba(15, 23, 42, 0.15)';
        el.innerText = esMultiEntrega ? `${textoOrdenVisual}+` : textoOrdenVisual;

        let HTMLBurbuja = "";
        if (esInicio || esFin) {
            HTMLBurbuja = `<div class="p-1 text-slate-800 font-sans"><div class="font-bold text-sm">${textoOrdenVisual}</div><div class="text-xs text-slate-500">📍 ${dirOficial}</div></div>`;
        } else if (esMultiEntrega) {
            const listadoPaquetes = mapaBurbujas[claveCoordActual] || [];
            let htmlItems = listadoPaquetes.map((p, i) => `
                <div class="${i > 0 ? 'border-t border-slate-100 pt-1.5 mt-1.5' : ''}">
                    <div class="flex justify-between text-[10px] font-bold text-amber-600 mb-0.5"><span>📦 PAQUETE: ${p.idPaquete}</span><span>Fila: #${p.numExcel}</span></div>
                    <div class="font-bold text-xs text-slate-800">👤 ${p.nomCliente}</div>
                </div>
            `).join('');
            HTMLBurbuja = `<div class="p-2 font-sans min-w-[220px]"><div class="text-[10px] font-extrabold text-center bg-amber-50 text-amber-800 py-1 rounded mb-2 border border-amber-200">⚠️ ¡DIRECCIÓN CON ${listadoPaquetes.length} ENTREGAS!</div><div class="max-h-[180px] overflow-y-auto pr-1">${htmlItems}</div><div class="text-[11px] text-slate-400 border-t border-slate-100 pt-1.5 mt-2 truncate">📍 ${dirOficial}</div></div>`;
        } else {
            HTMLBurbuja = `<div class="p-1 font-sans"><div class="text-[10px] font-bold text-emerald-600 uppercase mb-0.5">Parada Nº ${textoOrdenVisual} • Paquete: ${idPaquete}</div><div class="font-bold text-sm border-b border-slate-100 pb-1 mb-1 text-slate-800">👤 ${nomCliente}</div><div class="text-xs text-slate-500">Excel: #${numExcel}<br>📍 ${dirOficial}</div></div>`;
        }

        if (!isNaN(parada.lng) && !isNaN(parada.lat)) {
            const popup = new mapboxgl.Popup({ offset: 25 }).setHTML(HTMLBurbuja);
            const marcador = new mapboxgl.Marker(el).setLngLat([parseFloat(parada.lng), parseFloat(parada.lat)]).setPopup(popup).addTo(map);
            marcadoresRuta.push(marcador);
            diccionarioMarcadores[claveDiccionario] = marcador;
        }
    });
}
