// Configuración Inicial de Tokens
mapboxgl.accessToken = 'pk.eyJ1Ijoic2ViYXN0MjEiLCJhIjoiY21wcHRpdDV3MGoxZTJycTZsbXhjaXY3ZyJ9.Orx8pP8h7z0D4KjSlXyBoQ';
// 1. Inicializar el Mapa de Mapbox
const map = new mapboxgl.Map({
    container: 'map',
    style: 'mapbox://styles/mapbox/dark-v11', // Tema oscuro ideal para conductores
    center: [-118.24368, 34.05223], // Madrid por defecto (Lng, Lat)
    zoom: 5
});

// 2. Sistema de navegación por pestañas para el móvil
const btnLista = document.getElementById('nav-lista');
const btnMapa = document.getElementById('nav-mapa');
const tabLista = document.getElementById('tab-lista');
const tabMapa = document.getElementById('tab-mapa');

btnLista.addEventListener('click', () => {
    cambiarPestana(btnLista, btnMapa, tabLista, tabMapa);
});

btnMapa.addEventListener('click', () => {
    cambiarPestana(btnMapa, btnLista, tabMapa, tabLista);
    // Forzar a Mapbox a recalcular el tamaño del contenedor al hacerse visible
    setTimeout(() => map.resize(), 100); 
});

function cambiarPestana(activaBtn, inactivaBtn, activaTab, inactivaTab) {
    if (!activaBtn || !inactivaBtn || !activaTab || !inactivaTab) {
        console.warn("Advertencia: Uno de los elementos de las pestañas no se encontró en el DOM.");
        return; 
    }

    activaBtn.classList.remove('text-gray-400');
    activaBtn.classList.add('text-emerald-400');

    inactivaBtn.classList.remove('text-emerald-400');
    inactivaBtn.classList.add('text-gray-400');

    activaTab.classList.add('active');
    inactivaTab.classList.remove('active');
}

// Variable global para almacenar marcadores activos
let marcadoresRuta = [];

// 3. Lógica de Enrutamiento con OSRM + Parseo de Tabuladores (Excel/Sheets)
document.getElementById('btn-optimizar').addEventListener('click', async () => {
    const btn = document.getElementById('btn-optimizar');
    if (btn.disabled) return; 

    const texto = document.getElementById('input-direcciones').value.trim();
    if (!texto) return alert("Por favor, introduce la lista de datos.");

    // Separamos el bloque de texto por saltos de línea
    const lineas = texto.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    if (lineas.length < 2) return alert("Se necesitan al menos 2 registros para trazar la ruta.");

    btn.disabled = true;
    btn.innerText = "🔍 Procesando y Geocodificando...";

    let paradas = [];

    // --- PASO 1: PARSEAR TABULADORES Y GEOCODIFICAR ---
    for (let i = 0; i < lineas.length; i++) {
        const lineaCompleta = lineas[i];
        
        // Separamos la línea usando expresiones regulares para detectar tabuladores o múltiples espacios
        const partes = lineaCompleta.split(/\t+/).map(p => p.trim());
        
        // Si la línea se pegó con espacios normales en vez de tabuladores, usamos el plan B (separar por más de 2 espacios seguidos)
        const columnas = partes.length >= 4 ? partes : lineaCompleta.split(/ {2,}/).map(p => p.trim());

        // Asignación de variables según el orden solicitado (#, direccion, paquete, cliente)
        const numeroOrden   = columnas[0] || (i + 1);
        const direccionRaw  = columnas[1] || "";
        const paqueteId     = columnas[2] || "N/A";
        const nombreCliente = columnas[3] || "Cliente No Especificado";

        // Si por alguna razón la columna de la dirección quedó vacía, saltamos la línea
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
                
                // Estructuramos la metadata limpia de la parada
                paradas.push({
                    lng: lng,
                    lat: lat,
                    numero: numeroOrden,
                    direccionOficial: datosGeocode.features[0].place_name,
                    paquete: paqueteId,
                    cliente: nombreCliente
                });
                console.log(datosGeocode.features)
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

  // --- PASO 2: ENVIAR COORDENADAS OPTIMIZADAS POR BLOQUES COMPACTOS ---
    btn.innerText = "⏳ Agrupando rutas por cercanía...";

    // 1. Obtener coordenadas de los inputs de inicio y fin
    const startInput = document.getElementById('start-coords').value.trim().split(',');
    const endInput = document.getElementById('end-coords').value.trim().split(',');

    const startPoint = { lng: parseFloat(startInput[0]), lat: parseFloat(startInput[1]), numero: "START", cliente: "📍 Punto de Partida", paquete: "INICIO VIAJE" };
    const endPoint = { lng: parseFloat(endInput[0]), lat: parseFloat(endInput[1]), numero: "END", cliente: "🏁 Punto de Destino", paquete: "FIN VIAJE" };

    // 2. Limpieza de duplicados estrictos del Excel
    let paradasFiltro = paradas.filter((parada, index) => {
        if (index === 0) return true;
        const ant = paradas[index - 1];
        return !(parada.lng === ant.lng && parada.lat === ant.lat);
    });

    // 3. 🔥 ALGORITMO DE AGRUPACIÓN POR BLOQUE (VECINO MÁS CERCANO)
    // Esto evita saltos locos de un lado de la ciudad al otro
    let paradasPorBloque = [];
    let copiaExcel = [...paradasFiltro];
    let puntoActual = startPoint; // Comenzamos calculando desde el origen del chofer

    function calcularDistanciaManhattan(p1, p2) {
        // Cálculo rápido y eficiente para agrupación urbana
        return Math.abs(p1.lng - p2.lng) + Math.abs(p1.lat - p2.lat);
    }

    while (copiaExcel.length > 0) {
        let indiceMasCercano = 0;
        let distanciaMinima = Infinity;

        for (let i = 0; i < copiaExcel.length; i++) {
            let dist = calcularDistanciaManhattan(puntoActual, copiaExcel[i]);
            if (dist < distanciaMinima) {
                distanciaMinima = dist;
                indiceMasCercano = i;
            }
        }

        // Extraemos la parada más cercana para construir el bloque compacto
        let paradaSiguiente = copiaExcel.splice(indiceMasCercano, 1)[0];
        paradasPorBloque.push(paradaSiguiente);
        puntoActual = paradaSiguiente; // El siguiente punto busca desde esta última parada
    }

    // Aplicamos una微escala por si quedaron coordenadas idénticas para que OSRM no falle
    paradasPorBloque = paradasPorBloque.map((parada, index) => {
        let copia = { ...parada };
        const esDuplicado = paradasPorBloque.slice(0, index).some(p => p.lng === copia.lng && p.lat === copia.lat);
        if (esDuplicado) {
            copia.lng += (Math.random() - 0.5) * 0.00003;
            copia.lat += (Math.random() - 0.5) * 0.00003;
        }
        return copia;
    });

    // 4. ENSAMBLAMOS EL ITINERARIO DE CONDUCCIÓN COMPACTO
    let loteCompletoViaje = [startPoint, ...paradasPorBloque, endPoint];

    let data = null;
    let exito = false;

    // Ejecutamos las estrategias de OSRM con el bloque pre-ordenado
    for (let estrategia = 1; estrategia <= 2; estrategia++) {
        if (exito) break;

        const chainCoords = loteCompletoViaje.map(p => `${p.lng},${p.lat}`.replace(/\s+/g, '')).join(';');
        let urlOSRM = "";

        if (estrategia === 1) {
            // Forzamos un radio controlado (250m) para que no busque rutas alternativas cruzando la autopista
            const radiosString = loteCompletoViaje.map(() => "250").join(';');
            urlOSRM = `https://map-production-c2c6.up.railway.app/trip/v1/driving/${chainCoords}?overview=full&geometries=polyline&source=first&destination=last&radiuses=${radiosString}`;
        } 
        else if (estrategia === 2) {
            urlOSRM = `https://map-production-c2c6.up.railway.app/trip/v1/driving/${chainCoords}?overview=full&geometries=polyline&source=first&destination=last`;
        }

        try {
            console.log(`Enrutando bloque optimizado - Estrategia ${estrategia}`);
            const res = await fetch(urlOSRM);
            const respuestaJson = await res.json().catch(() => ({}));

            if (res.ok && respuestaJson.code === "Ok" && respuestaJson.trips && respuestaJson.trips.length > 0) {
                data = respuestaJson;
                exito = true;
                break;
            }
        } catch (error) {
            console.error(`Error en enrutamiento por bloques:`, error);
        }
    }

    // --- PASO 3: REORGANIZAR RESPUESTA PARA EL RENDERIZADOR (FORZAR REINYECCIÓN TOTAL) ---
    try {
        if (exito && data && data.trips && data.trips.length > 0 && data.waypoints) {
            
            // 1. Mapeamos la respuesta de OSRM vinculando el orden óptimo de visita
            let mapeoWaypoints = data.waypoints.map(wp => ({
                indiceOptimo: wp.trips_index,
                indiceOriginal: wp.waypoint_index
            }));

            // Ordenar de menor a mayor según la ruta de manejo real (0, 1, 2...)
            mapeoWaypoints.sort((a, b) => a.indiceOptimo - b.indiceOptimo);

            // 2. Extraer los puntos que OSRM sí pudo procesar en orden
            let paradasOptimizadas = [];
            mapeoWaypoints.forEach(item => {
                const punto = loteCompletoViaje[item.indiceOriginal];
                if (punto) paradasOptimizadas.push(punto);
            });

            // 3. 🔥 RESCATE MILIMÉTRICO: Forzar la aparición de las 53 direcciones del Excel
            // Si OSRM combinó o ignoró paradas por estar en el mismo edificio o bloque,
            // las buscamos en el archivo original del Excel y las metemos a la fuerza.
            let paradasFaltantes = paradas.filter(pOriginal => {
                return !paradasOptimizadas.some(pO => String(pO.numero) === String(pOriginal.numero));
            });

            if (paradasFaltantes.length > 0) {
                console.warn(`Reinyectando ${paradasFaltantes.length} paradas duplicadas u omitidas por OSRM.`);
                
                // Las acomodamos de forma inteligente: buscamos si otra parada comparte sus coordenadas
                // y la metemos justo al lado de ella en la lista de visita.
                paradasFaltantes.forEach(pf => {
                    const idxAsociado = paradasOptimizadas.findIndex(pO => Math.abs(pO.lng - pf.lng) < 0.0001 && Math.abs(pO.lat - pf.lat) < 0.0001);
                    if (idxAsociado !== -1) {
                        paradasOptimizadas.splice(idxAsociado + 1, 0, pf);
                    } else {
                        // Si no comparte edificio con nadie, la mandamos al final antes del destino
                        const indexFin = paradasOptimizadas.findIndex(p => String(p.numero) === "END");
                        if (indexFin !== -1) {
                            paradasOptimizadas.splice(indexFin, 0, pf);
                        } else {
                            paradasOptimizadas.push(pf);
                        }
                    }
                });
            }

            // 4. LIMPIEZA Y ENCAPSULAMIENTO ESTRICTO DE EXTREMOS
            // Quitamos cualquier duplicado residual de START/END y los fijamos magnéticamente
            paradasOptimizadas = paradasOptimizadas.filter(p => String(p.numero) !== "START" && String(p.numero) !== "END");
            
            // Forzamos el sándwich perfecto
            paradasOptimizadas.unshift(startPoint);
            paradasOptimizadas.push(endPoint);

            console.log(`🚀 Renderizando lote final de entrega. Total paradas en interfaz: ${paradasOptimizadas.length}`);

            // Enviar el listado corregido al mapa y a las tarjetas laterales
            renderizarRutaOSRM(data.trips[0], paradasOptimizadas);
            
        } else {
            alert("No se pudo estructurar un viaje optimizado continuo con los puntos de control.");
        }
    } catch (err) {
        console.error("Error crítico en ordenamiento e indexación:", err);
        alert("Ocurrió un problema al procesar el listado de las paradas.");
    } finally {
        btn.disabled = false;
        btn.innerText = "⚡ Convertir y Optimizar Ruta";
    }
});

// 4. Renderizar resultados optimizados en pantalla y mapa
function renderizarRutaOSRM(osrmTripData, paradasOrdenadas) {
    const listaUl = document.getElementById('lista-ordenada');
    if (listaUl) listaUl.innerHTML = ''; 

    // Limpiar marcadores antiguos del mapa
    if (typeof marcadoresRuta !== 'undefined') {
        marcadoresRuta.forEach(marker => marker.remove());
        marcadoresRuta = [];
    } else {
        window.marcadoresRuta = [];
    }

    // 🔥 Objeto global o temporal para mapear las coordenadas a los marcadores reales de Mapbox
    const diccionarioMarcadores = {};

    // Calcular estadísticas globales reales
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

    // 1. PRIMERA PASADA: Agrupar los datos de texto para las burbujas
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

    // 2. SEGUNDA PASADA: Dibujar las tarjetas, botones de grupo y los pines en el mapa
    paradasOrdenadas.forEach((parada, idx) => {
        if (!parada) return; 

        const esInicio = String(parada.numero) === "START";
        const esFin = String(parada.numero) === "END";
        
        // Colores adaptados a la paleta Dark/Orange
        let colorBorde = "border-orange-500"; 
        let badgeClase = "bg-orange-900/40 text-orange-400"; 
        let colorPin = "#f97316"; 
        let textoOrdenVisual = "";
        let esMultiEntrega = false;
        let claveCoordActual = "";

        if (esInicio) {
            colorBorde = "border-gray-500";
            badgeClase = "bg-gray-800 text-gray-300";
            colorPin = "#6b7280"; 
            textoOrdenVisual = "🛫 Salida";
        } else if (esFin) {
            colorBorde = "border-gray-700";
            badgeClase = "bg-gray-900 text-gray-500";
            colorPin = "#374151"; 
            textoOrdenVisual = "🏁 Fin";
        } else {
            contadorEntregas++;
            textoOrdenVisual = contadorEntregas;

            claveCoordActual = `${parseFloat(parada.lng).toFixed(5)}_${parseFloat(parada.lat).toFixed(5)}`;
            const paquetesEnEstaDireccion = mapaBurbujas[claveCoordActual] || [];

            if (paquetesEnEstaDireccion.length >= 2) {
                esMultiEntrega = true;
                colorBorde = "border-yellow-500";
                badgeClase = "bg-yellow-900/40 text-yellow-400";
                colorPin = "#eab308"; 
            }

           
            // 🔥 LÓGICA DE AGRUPACIÓN: NAVEGACIÓN GPS DIRECTA FORZADA PARA AMBOS MAPAS 🔥
            if ((contadorEntregas - 1) % 10 === 0) {
                
                // Filtramos solo las entregas reales (sin contar START ni END)
                const entregasSolo = paradasOrdenadas.filter(p => String(p.numero) !== "START" && String(p.numero) !== "END");
                // Extraemos las 10 entregas de este bloque
                const entregasLote = entregasSolo.slice(contadorEntregas - 1, contadorEntregas - 1 + 10);
                
                // --- 1. LIMPIEZA Y PREPARACIÓN DE DIRECCIONES ---
                const direccionesLimpias = entregasLote.map(p => {
                    let texto = p.direccionOficial || p.direccion || "Direccion Desconocida";
                    // Limpieza estándar: quitar país y borrar comas
                    texto = texto.replace(/,?\s*united states\s*$/gi, '').replace(/,?\s*usa\s*$/gi, '').replace(/,/g, '');
                    return encodeURIComponent(texto).replace(/%20/g, '+');
                });

                // --- 2. LINK APPLE MAPS (NATIVO - LISTO PARA NAVEGAR) ---
                const destinoApple = direccionesLimpias[direccionesLimpias.length - 1];
                const waypointsApple = direccionesLimpias.slice(0, -1).map(dir => `waypoint=${dir}`).join('&');
                const urlAppleMaps = `maps://maps.apple.com/directions?mode=driving&origin=Current+Location&destination=${destinoApple}${waypointsApple ? '&' + waypointsApple : ''}`;

                // --- 3. LINK GOOGLE MAPS (PROTOCOLO NATIVO DE NAVEGACIÓN INMEDIATA) ---
                const primerDestinoGoogle = direccionesLimpias[0];
                // Las paradas de la 2 a la 10 se añaden de forma nativa a la cola del itinerario
                const paradasExtrasGoogle = direccionesLimpias.slice(1).join('|');
                
                // 🧭 El parámetro google.navigation:q= arranca el GPS al instante y desbloquea el viaje por etapas
                const urlGoogleMaps = `google.navigation:q=${primerDestinoGoogle}&waypoints=${paradasExtrasGoogle}&mode=d`;
                
                const numeroLote = Math.floor((contadorEntregas - 1) / 10) + 1;
                const entregaFin = (contadorEntregas - 1) + entregasLote.length;

                // --- 4. CONSTRUCCIÓN DE LA INTERFAZ CON DOBLE BOTÓN ---
                const liGrupo = document.createElement('li');
                liGrupo.className = "bg-gray-950 p-4 rounded-xl border border-gray-800 mt-6 mb-3 shadow-lg relative overflow-hidden";
                liGrupo.innerHTML = `
                    <div class="absolute left-0 top-0 bottom-0 w-1.5 bg-gradient-to-b from-blue-500 to-green-500"></div>
                    <div class="flex justify-between items-center mb-4 pl-2">
                        <span class="text-white font-extrabold text-sm uppercase tracking-wider">📦 Lote de Ruta ${numeroLote}</span>
                        <span class="text-xs bg-gray-900 text-gray-400 border border-gray-800 px-2 py-1 rounded-md font-mono">
                            Entregas ${contadorEntregas} a ${entregaFin}
                        </span>
                    </div>
                    
                    <div class="flex gap-2 w-full">
                        <a href="${urlAppleMaps}" target="_blank" 
                           class="flex-1 bg-blue-600 hover:bg-blue-700 active:scale-[0.98] text-white font-bold py-3 px-2 rounded-lg transition-all duration-200 flex justify-center items-center gap-1.5 text-xs shadow-[0_0_15px_rgba(37,99,235,0.15)] text-center">
                            🧭 Apple Maps
                        </a>
                        
                        <a href="${urlGoogleMaps}" 
                           class="flex-1 bg-emerald-600 hover:bg-emerald-700 active:scale-[0.98] text-white font-bold py-3 px-2 rounded-lg transition-all duration-200 flex justify-center items-center gap-1.5 text-xs shadow-[0_0_15px_rgba(16,185,129,0.15)] text-center">
                            🗺️ Google Maps
                        </a>
                    </div>
                `;
                if (listaUl) listaUl.appendChild(liGrupo);
            }
        }
        
        const numExcel = parada.numero || idx;
        const idPaquete = parada.paquete || "N/A";
        const nomCliente = parada.cliente || "Cliente Sin Nombre";
        const dirOficial = parada.direccionOficial || parada.direccion || "Dirección no disponible";

        // A. Renderizar tarjeta lateral (Actualizada al diseño oscuro)
        const li = document.createElement('li');
        li.className = `flex justify-between items-center bg-gray-950 p-3 rounded-lg border-l-4 ${colorBorde} cursor-pointer hover:bg-gray-900 transition mb-2`;
        
        li.innerHTML = `
            <div class="flex-1 min-w-0 pr-2 flex flex-col gap-0.5">
                <div class="flex items-center gap-1.5">
                    ${!esInicio && !esFin ? `<span class="text-[10px] font-bold px-1.5 py-0.5 rounded ${badgeClase}">Fila: #${numExcel}</span>` : ''}
                    <span class="text-xs ${colorPin === "#eab308" ? "text-yellow-400" : (esInicio || esFin ? "text-gray-400" : "text-orange-500")} font-bold font-mono">
                        ${esInicio || esFin ? textoOrdenVisual : `Orden: ${textoOrdenVisual}`}
                    </span>
                </div>
                ${!esInicio && !esFin ? `<div class="text-xs text-gray-500 font-medium mt-1">📦 Pqt: ${idPaquete}</div>` : ''}
                <span class="text-xs md:text-sm font-semibold text-gray-200 truncate mt-0.5">👤 ${nomCliente}</span>
                <span class="text-[11px] text-gray-500 truncate">📍 ${dirOficial}</span>
            </div>
            <a href="https://www.google.com/maps/dir/?api=1&destination=${parada.lat},${parada.lng}" target="_blank" 
               class="bg-gray-800 hover:bg-orange-500 hover:text-black text-gray-300 text-xs px-3 py-2 rounded-md font-bold transition-colors no-underline flex items-center gap-1 shrink-0 h-fit stop-propagation border border-gray-700 hover:border-orange-500">
                Individual
            </a>
        `;

        // Evento de click para centrar en el mapa
        li.addEventListener('click', (e) => {
            if (e.target.closest('.stop-propagation')) return;
            const botonPestañaMapa = document.getElementById('nav-mapa');
            if (botonPestañaMapa) botonPestañaMapa.click();

            if (!isNaN(parada.lng) && !isNaN(parada.lat)) {
                map.flyTo({ center: [parseFloat(parada.lng), parseFloat(parada.lat)], zoom: 16, essential: true, speed: 1.2 });
                const claveBuscar = esInicio ? "START" : esFin ? "END" : `${parseFloat(parada.lng).toFixed(5)}_${parseFloat(parada.lat).toFixed(5)}`;
                const marcadorAsociado = diccionarioMarcadores[claveBuscar];
                if (marcadorAsociado) marcadorAsociado.togglePopup();
            }
        });

        if (listaUl) listaUl.appendChild(li);

        // -- CONTINÚA TU CÓDIGO ORIGINAL DESDE AQUÍ --
        // B. RENDERIZADO DEL PIN ÚNICO...

        // B. RENDERIZADO DEL PIN ÚNICO (Control de duplicación)
        let claveDiccionario = esInicio ? "START" : esFin ? "END" : `${parseFloat(parada.lng).toFixed(5)}_${parseFloat(parada.lat).toFixed(5)}`;
        
        if (!esInicio && !esFin) {
            const yaExisteMarcador = marcadoresRuta.some(m => {
                const coord = m.getLngLat();
                return coord.lng.toFixed(5) === parseFloat(parada.lng).toFixed(5) && 
                       coord.lat.toFixed(5) === parseFloat(parada.lat).toFixed(5);
            });
            
            // Si ya existe en el mapa, no volvemos a dibujar el pin, pero la tarjeta sí se creó arriba
            if (yaExisteMarcador) return; 
        }

        // C. Crear el elemento visual del PIN
        const el = document.createElement('div');
        el.className = 'custom-marker';
        el.style.backgroundColor = colorPin;
        el.style.width = esInicio || esFin ? '32px' : '26px'; 
        el.style.height = esInicio || esFin ? '32px' : '26px';
        el.style.borderRadius = '50%';
        el.style.border = '2px solid #ffffff';
        el.style.display = 'flex';
        el.style.alignItems = 'center';
        el.style.justifyContent = 'center';
        el.style.color = colorPin === "#f59e0b" ? "#000000" : "#ffffff"; 
        el.style.fontSize = esInicio || esFin ? '9px' : '11px';
        el.style.fontWeight = 'bold';
        el.style.boxShadow = '0 2px 5px rgba(0,0,0,0.5)';
        el.innerText = esMultiEntrega ? `${textoOrdenVisual}+` : textoOrdenVisual;

        // D. CONSTRUCCIÓN DE LA BURBUJA INTERACTIVA UNIFICADA
        let HTMLBurbuja = "";
        if (esInicio || esFin) {
            HTMLBurbuja = `
                <div class="p-1 text-gray-900 font-sans">
                    <div class="font-bold text-sm text-gray-800">${textoOrdenVisual}</div>
                    <div class="text-xs text-gray-600">📍 ${dirOficial}</div>
                </div>
            `;
        } else if (esMultiEntrega) {
            const listadoPaquetes = mapaBurbujas[claveCoordActual] || [];
            let htmlItems = listadoPaquetes.map((p, i) => `
                <div class="${i > 0 ? 'border-t border-gray-100 pt-1.5 mt-1.5' : ''}">
                    <div class="flex justify-between text-[10px] font-bold text-amber-600 mb-0.5">
                        <span>📦 PAQUETE: ${p.idPaquete}</span>
                        <span>Fila Excel: #${p.numExcel}</span>
                    </div>
                    <div class="font-bold text-xs text-gray-800">👤 ${p.nomCliente}</div>
                </div>
            `).join('');

            HTMLBurbuja = `
                <div class="p-2 text-gray-900 font-sans min-w-[220px]">
                    <div class="text-[10px] font-extrabold text-center bg-yellow-100 text-yellow-800 py-1 rounded mb-2 uppercase tracking-wide">
                        ⚠️ ¡DIRECCIÓN CON ${listadoPaquetes.length} ENTREGAS!
                    </div>
                    <div class="max-h-[180px] overflow-y-auto pr-1">
                        ${htmlItems}
                    </div>
                    <div class="text-[11px] text-gray-500 border-t border-gray-200 pt-1.5 mt-2 italic truncate">
                        📍 ${dirOficial}
                    </div>
                </div>
            `;
        } else {
            HTMLBurbuja = `
                <div class="p-1 text-gray-900 font-sans">
                    <div class="text-[10px] font-bold text-emerald-600 uppercase tracking-wide mb-0.5">
                        ¡Parada Nº ${textoOrdenVisual}! • Paquete: ${idPaquete}
                    </div>
                    <div class="font-bold text-sm border-b border-gray-200 pb-1 mb-1 text-gray-800">
                        👤 ${nomCliente}
                    </div>
                    <div class="text-xs text-gray-600">
                        Excel Fila: #${numExcel}<br>
                        📍 ${dirOficial}
                    </div>
                </div>
            `;
        }

        // E. Estampar el marcador final en Mapbox
        if (!isNaN(parada.lng) && !isNaN(parada.lat)) {
            const popup = new mapboxgl.Popup({ offset: 25 }).setHTML(HTMLBurbuja);
            const marcador = new mapboxgl.Marker(el)
                .setLngLat([parseFloat(parada.lng), parseFloat(parada.lat)])
                .setPopup(popup)
                .addTo(map);

            marcadoresRuta.push(marcador);
            
            // 🔥 Guardamos la referencia de este marcador en nuestro diccionario temporal
            diccionarioMarcadores[claveDiccionario] = marcador;
        }
    });

    // 4. Pintado directo de la línea de ruta uniendo los marcadores
    try {
        const coordenadasSeguras = paradasOrdenadas
            .filter(p => p && !isNaN(p.lng) && !isNaN(p.lat))
            .map(p => [parseFloat(p.lng), parseFloat(p.lat)]);

        if (coordenadasSeguras && coordenadasSeguras.length > 0) {
            const geojson = {
                "type": "Feature",
                "properties": {},
                "geometry": { "type": "LineString", "coordinates": coordenadasSeguras }
            };

            if (map.getSource('route')) {
                map.getSource('route').setData(geojson);
            } else {
                map.addSource('route', { 'type': 'geojson', 'data': geojson });
                map.addLayer({
                    'id': 'route',
                    'type': 'line',
                    'source': 'route',
                    'layout': { 'line-join': 'round', 'line-cap': 'round' },
                    'paint': {
                        'line-color': '#3b82f6',
                        'line-width': 5,
                        'line-opacity': 0.85
                    }
                });
            }
        }
    } catch (err) {
        console.error("Error en trazado de línea:", err);
    }
}

// 5. Pintar la línea GeoJSON en Mapbox y ajustar la cámara
function dibujarRuta(coordenadas) {
    if (map.getSource('ruta-optimizada')) {
        map.getSource('ruta-optimizada').setData({
            'type': 'Feature',
            'geometry': { 'type': 'LineString', 'coordinates': coordenadas }
        });
    } else {
        map.addSource('ruta-optimizada', {
            'type': 'geojson',
            'data': { 'type': 'Feature', 'geometry': { 'type': 'LineString', 'coordinates': coordenadas } }
        });
        map.addLayer({
            'id': 'ruta-optimizada',
            'type': 'line',
            'source': 'ruta-optimizada',
            'paint': { 'line-color': '#10b981', 'line-width': 5, 'line-opacity': 0.85 }
        });
    }

    const bounds = coordenadas.reduce((acc, coord) => acc.extend(coord), new mapboxgl.LngLatBounds(coordenadas[0], coordenadas[0]));
    map.fitBounds(bounds, { padding: 50 });
}
