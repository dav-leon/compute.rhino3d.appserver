import * as THREE from "three";
import { OrbitControls } from "https://unpkg.com/three@0.137.5/examples/jsm/controls/OrbitControls.js";
import { Rhino3dmLoader } from "https://unpkg.com/three@0.137.5/examples/jsm/loaders/3DMLoader.js";
import { TransformControls } from "https://unpkg.com/three@0.137.5/examples/jsm/controls/TransformControls.js";
import { RGBELoader } from "https://unpkg.com/three@0.137.5/examples/jsm/loaders/RGBELoader.js";
import rhino3dm from "https://cdn.jsdelivr.net/npm/rhino3dm@7.11.1/rhino3dm.module.js";
import TWEEN from "https://cdn.jsdelivr.net/npm/@tweenjs/tween.js@18.5.0/dist/tween.esm.js";

// set up loader for converting the results to threejs
const loader = new Rhino3dmLoader();
loader.setLibraryPath("https://cdn.jsdelivr.net/npm/rhino3dm@7.14.0/");

const merge_box = document.getElementById("merge");
merge_box.addEventListener("click", onSliderChange, false);
const scale_slider = document.getElementById("scale");
scale_slider.addEventListener("mouseup", onSliderChange, false);
scale_slider.addEventListener("touchend", onSliderChange, false);

// initialise 'data' object that will be used by compute()
let data = {};
data.definition = "mesh_union_toggle.gh";
data.inputs = {
  merge: merge_box.checked,
  scale: scale_slider.valueAsNumber,
  meshes: [],
};

// globals
let rhino, definition, doc;

rhino3dm().then(async (m) => {
  rhino = m;

  init();
  //compute();
});

const downloadButton = document.getElementById("downloadButton");
downloadButton.onclick = download;

/////////////////////////////////////////////////////////////////////////////
//                            HELPER  FUNCTIONS                            //
/////////////////////////////////////////////////////////////////////////////
async function readSingleFile(e) {
  // get file
  var file = e.target.files[0];
  if (!file) {
    document.getElementById("msg").innerText = "Something went wrong...";
    return;
  }

  // try to open 3dm file
  const buffer = await file.arrayBuffer();
  const uploadDoc = rhino.File3dm.fromByteArray(new Uint8Array(buffer));

  if (uploadDoc === null) {
    document.getElementById("msg").innerText = "Must be a .3dm file!";
    return;
  }

  // get geometry from file
  const objs = uploadDoc.objects();
  const geometry = [];
  for (let i = 0; i < objs.count; i++) {
    const geom = objs.get(i).geometry();
    // filter for geometry of a specific type
    geometry.push(JSON.stringify(geom));
  }

  // solve!
  data.inputs.meshes = geometry;
  compute();
}

// register event listener for file input
document
  .getElementById("file-input")
  .addEventListener("change", readSingleFile, false);

// more globals
let scene, camera, renderer, controls;

/**
 * Sets up the scene, camera, renderer, lights and controls and starts the animation
 */
function init() {
  // Rhino models are z-up, so set this as the default
  THREE.Object3D.DefaultUp = new THREE.Vector3(0, 0, 1);

  // create a scene and a camera
  scene = new THREE.Scene();
  scene.background = new THREE.Color(1, 1, 1);
  camera = new THREE.PerspectiveCamera(
    45,
    window.innerWidth / window.innerHeight,
    1,
    1000
  );
  camera.position.set(1, -1, 1); // like perspective view

  // very light grey for background, like rhino
  scene.background = new THREE.Color("whitesmoke");

  // create the renderer and add it to the html
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  document.body.appendChild(renderer.domElement);

  // add some controls to orbit the camera
  controls = new OrbitControls(camera, renderer.domElement);

  // add a directional light
  const directionalLight = new THREE.DirectionalLight(0xffffff);
  directionalLight.intensity = 2;
  scene.add(directionalLight);

  const ambientLight = new THREE.AmbientLight();
  scene.add(ambientLight);

  // handle changes in the window size
  window.addEventListener("resize", onWindowResize, false);

  animate();
}

/**
 * Call appserver
 */
async function compute() {
  showSpinner(true);

  // // construct url for GET /solve/definition.gh?name=value(&...)
  // const url = new URL("/solve/" + data.definition, window.location.origin);
  // Object.keys(data.inputs).forEach((key) =>
  //   url.searchParams.append(key, data.inputs[key])
  // );
  // console.log(url.toString());

  // try {
  //   const response = await fetch(url);
  // use POST request
  const request = {
    method: "POST",
    body: JSON.stringify(data),
    headers: { "Content-Type": "application/json" },
  };

  try {
    const response = await fetch("/solve", request);

    if (!response.ok) {
      // TODO: check for errors in response json
      throw new Error(response.statusText);
    }

    const responseJson = await response.json();

    collectResults(responseJson);
  } catch (error) {
    console.error(error);
  }
}

/**
 * Parse response
 */
function collectResults(responseJson) {
  const values = responseJson.values;

  // clear doc
  if (doc !== undefined) doc.delete();

  //console.log(values)
  doc = new rhino.File3dm();

  // for each output (RH_OUT:*)...
  for (let i = 0; i < values.length; i++) {
    // ...iterate through data tree structure...
    for (const path in values[i].InnerTree) {
      const branch = values[i].InnerTree[path];
      // ...and for each branch...
      for (let j = 0; j < branch.length; j++) {
        // ...load rhino geometry into doc
        const rhinoObject = decodeItem(branch[j]);
        if (rhinoObject !== null) {
          doc.objects().add(rhinoObject, null);
        }
      }
    }
  }

  if (doc.objects().count < 1) {
    console.error("No rhino objects to load!");
    showSpinner(false);
    return;
  }

  // hack (https://github.com/mcneel/rhino3dm/issues/353)
  const sphereAttrs = new rhino.ObjectAttributes();
  sphereAttrs.mode = rhino.ObjectMode.Hidden;
  doc.objects().addSphere(new rhino.Sphere([0, 0, 0], 0.001), sphereAttrs);

  // load rhino doc into three.js scene
  const buffer = new Uint8Array(doc.toByteArray()).buffer;
  loader.parse(buffer, function (object) {
    // debug

    object.traverse((child) => {
      if (child.isMesh)
        child.material = new THREE.MeshNormalMaterial({
          wireframe: true,
        });
    }, false);

    // clear objects from scene. do this here to avoid blink
    scene.traverse((child) => {
      if (!child.isLight) {
        scene.remove(child);
      }
    });

    // add object graph from rhino model to three.js scene
    scene.add(object);

    // hide spinner and enable download button
    showSpinner(false);
    downloadButton.disabled = false;

    // zoom to extents
    zoomCameraToSelection(camera, controls, scene.children);
  });
}

/**
 * Attempt to decode data tree item to rhino geometry
 */
function decodeItem(item) {
  const data = JSON.parse(item.data);
  if (item.type === "System.String") {
    // hack for draco meshes
    try {
      return rhino.DracoCompression.decompressBase64String(data);
    } catch {} // ignore errors (maybe the string was just a string...)
  } else if (typeof data === "object") {
    return rhino.CommonObject.decode(data);
  }
  return null;
}

/**
 * Called when a slider value changes in the UI. Collect all of the
 * slider values and call compute to solve for a new scene
 */
function onSliderChange() {
  showSpinner(true);
  // get slider values
  let inputs = {};
  for (const input of document.getElementsByTagName("input")) {
    switch (input.type) {
      case "number":
        inputs[input.id] = input.valueAsNumber;
        break;
      case "range":
        inputs[input.id] = input.valueAsNumber;
        break;
      case "checkbox":
        inputs[input.id] = input.checked;
        break;
    }
  }

  data.inputs = inputs;

  compute();
}

/**
 * The animation loop!
 */
function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}

/**
 * Helper function for window resizes (resets the camera pov and renderer size)
 */
function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  animate();
}

/**
 * Helper function that behaves like rhino's "zoom to selection", but for three.js!
 */
function zoomCameraToSelection(camera, controls, selection, fitOffset = 1.2) {
  const box = new THREE.Box3();

  for (const object of selection) {
    if (object.isLight) continue;
    box.expandByObject(object);
  }

  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());

  const maxSize = Math.max(size.x, size.y, size.z);
  const fitHeightDistance =
    maxSize / (2 * Math.atan((Math.PI * camera.fov) / 360));
  const fitWidthDistance = fitHeightDistance / camera.aspect;
  const distance = fitOffset * Math.max(fitHeightDistance, fitWidthDistance);

  const direction = controls.target
    .clone()
    .sub(camera.position)
    .normalize()
    .multiplyScalar(distance);
  controls.maxDistance = distance * 10;
  controls.target.copy(center);

  camera.near = distance / 100;
  camera.far = distance * 100;
  camera.updateProjectionMatrix();
  camera.position.copy(controls.target).sub(direction);

  controls.update();
}

/**
 * This function is called when the download button is clicked
 */
function download() {
  // write rhino doc to "blob"
  const bytes = doc.toByteArray();
  const blob = new Blob([bytes], { type: "application/octect-stream" });

  // use "hidden link" trick to get the browser to download the blob
  const filename = data.definition.replace(/\.gh$/, "") + ".3dm";
  const link = document.createElement("a");
  link.href = window.URL.createObjectURL(blob);
  link.download = filename;
  link.click();
}

/**
 * Shows or hides the loading spinner
 */
function showSpinner(enable) {
  if (enable) document.getElementById("loader").style.display = "block";
  else document.getElementById("loader").style.display = "none";
}
