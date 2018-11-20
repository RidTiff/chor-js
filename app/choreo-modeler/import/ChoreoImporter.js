import {
  assign,
  map
} from 'min-dash';

import { is } from 'bpmn-js/lib/util/ModelUtil';

import {
  isLabelExternal,
  getExternalLabelBounds
} from 'bpmn-js/lib/util/LabelUtil';

import {
  getMid
} from 'diagram-js/lib/layout/LayoutUtil';

import {
  isExpanded
} from 'bpmn-js/lib/util/DiUtil';

import {
  getBandGapIndex,
  getBandHeight
} from '../util/BandUtil';

function elementToString(e) {
  if (!e) {
    return '<null>';
  }
  return '<' + e.$type + (e.id ? ' id="' + e.id : '') + '" />';
}

function elementData(semantic, attrs) {
  return assign({
    id: semantic.id,
    type: semantic.$type,
    businessObject: semantic
  }, attrs);
}

function collectWaypoints(waypoints) {
  return map(waypoints, function(p) {
    return { x: p.x, y: p.y };
  });
}

function notYetDrawn(translate, semantic, refSemantic, property) {
  return new Error(translate('element {element} referenced by {referenced}#{property} not yet drawn', {
    element: elementToString(refSemantic),
    referenced: elementToString(semantic),
    property: property
  }));
}

/**
 * An importer that adds BPMN 2.0 choreography elements to the canvas.
 *
 * @param {EventBus} eventBus
 * @param {Canvas} canvas
 * @param {ElementFactory} elementFactory
 * @param {ElementRegistry} elementRegistry
 * @param {Function} translate
 * @param {TextRenderer} textRenderer
 */
export default function ChoreoImporter(
    eventBus, canvas, elementFactory,
    elementRegistry, translate, textRenderer) {

  this._eventBus = eventBus;
  this._canvas = canvas;
  this._elementFactory = elementFactory;
  this._elementRegistry = elementRegistry;
  this._translate = translate;
  this._textRenderer = textRenderer;
}

ChoreoImporter.$inject = [
  'eventBus',
  'canvas',
  'elementFactory',
  'elementRegistry',
  'translate',
  'textRenderer'
];


/**
 * Add bpmn element (semantic) to the canvas onto the specified parent shape.
 */
ChoreoImporter.prototype.add = function(semantic, parentElement) {
  var di,
      element,
      translate = this._translate,
      hidden;

  var isParticipantBand = is(semantic, 'bpmn:Participant') && is(parentElement, 'bpmn:ChoreographyActivity');
  var isChoreoActivity = is(semantic, 'bpmn:ChoreographyActivity');

  // get the DI object corresponding to this element
  if (isParticipantBand) {
    /*
     * For participant bands, the DI object is not as easy to get as there can
     * be multiple bands for the same semantic object (i.e., a bpmn:Participant).
     * For that reason, we have to iterate through all band DIs and find the right one.
     */
    di = semantic.di.$parent.planeElement.find(
      diBand => diBand.choreographyActivityShape === parentElement.businessObject.di && diBand.bpmnElement === semantic
    );
  } else {
    di = semantic.di;
  }

  /**
   * For choreography activities, we order the participants according
   * to the y position of their band. We then reposition and resize the
   * bands to fit the look and feel of our modeler.
   *
   * On a side note, we set the properties of the di elements ourselves
   * and largely ignore the values in the model. Most external modelers do
   * not properly maintain these values and they can not really be trusted.
   */
  if (isChoreoActivity) {
    let participants = semantic.participantRefs;

    // temporarily link all participant business objects to the di band
    // for this specific choreography activity
    participants.forEach(participant => {
      participant.diBand = semantic.di.$parent.planeElement.find(
        diBand => diBand.choreographyActivityShape === di && diBand.bpmnElement === participant
      );
    });

    // sort the participants by their y coordinate and get all the di bands
    participants.sort((left, right) => - left.diBand.bounds.y - right.diBand.bounds.y);
    let diBands = participants.map(participant => participant.diBand);

    // remove the temporary reference to the di band we stored in participants
    participants.forEach(participant => {
      delete participant.diBand;
    });

    // set the bounds (except for y) for each band
    diBands.forEach(diBand => {
      diBand.bounds = {
        x: di.bounds.x,
        width: di.bounds.width,
        height: getBandHeight(diBand.bpmnElement)
      };
    });

    // then, set the y position for all top bands
    for (let offset = 0, i = 0; i < getBandGapIndex(diBands.length); i++) {
      diBands[i].bounds.y = di.bounds.y + offset;
      offset += diBands[i].bounds.height;
    }

    // then, set the y position for all bottom bands
    for (let offset = 0, i = diBands.length - 1; i >= getBandGapIndex(diBands.length); i--) {
      offset += diBands[i].bounds.height;
      diBands[i].bounds.y = di.bounds.y + di.bounds.height - offset;
    }

    // update the participant band kind of all bands
    diBands.forEach((diBand, index) => {
      let bandKind;
      if (index == 0) {
        bandKind = 'top_';
      } else if (index == diBands.length - 1) {
        bandKind = 'bottom_';
      } else {
        bandKind = 'middle_';
      }
      if (diBand.bpmnElement === semantic.initiatingParticipantRef) {
        bandKind += 'initiating';
      } else {
        bandKind += 'non_initiating';
      }
      diBand.participantBandKind = bandKind;
    });

    // messages can only be visible for choreography tasks
    if (!is(semantic, 'bpmn:ChoreographyTask')) {
      diBands.forEach(diBand => {
        diBand.isMessageVisible = false;
      });
    }
  }

  var parentIndex;

  // ROOT ELEMENT
  // handle the special case that we deal with a
  // invisible root element (process or collaboration)
  if (is(di, 'bpmndi:BPMNPlane')) {

    // add a virtual element (not being drawn)
    element = this._elementFactory.createRoot(elementData(semantic));

    this._canvas.setRootElement(element);
  }

  // SHAPE
  else if (is(di, 'bpmndi:BPMNShape')) {

    var collapsed = !isExpanded(semantic);
    hidden = parentElement && (parentElement.hidden || parentElement.collapsed);

    var bounds = di.bounds;

    var data = elementData(semantic, {
      collapsed: collapsed,
      hidden: hidden,
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height)
    });

    // choreography activity shapes need references to the band shapes
    if (isChoreoActivity) {
      data = assign(data, {
        bandShapes: []
      });
    }

    // participant bands refer the same participant, so the IDs need to be
    // made unique here based on the choreography activity as well
    if (isParticipantBand) {
      data = assign(data, {
        id: semantic.id + '_' + parentElement.businessObject.id,
        activityShape: parentElement,
        diBand: di
      });
    }

    element = this._elementFactory.createShape(data);

    // add participant band shapes to choreo shape registry
    if (isParticipantBand) {
      parentElement.bandShapes.push(element);
    }

    if (is(semantic, 'bpmn:BoundaryEvent')) {
      this._attachBoundary(semantic, element);
    }

    // insert lanes behind other flow nodes (cf. #727)
    if (is(semantic, 'bpmn:Lane')) {
      parentIndex = 0;
    }

    if (is(semantic, 'bpmn:DataStoreReference')) {

      // check wether data store is inside our outside of its semantic parent
      if (!isPointInsideBBox(parentElement, getMid(bounds))) {
        parentElement = this._canvas.getRootElement();
      }
    }

    this._canvas.addShape(element, parentElement, parentIndex);
  }

  // CONNECTION
  else if (is(di, 'bpmndi:BPMNEdge')) {

    var source = this._getSource(semantic),
        target = this._getTarget(semantic);

    hidden = parentElement && (parentElement.hidden || parentElement.collapsed);

    element = this._elementFactory.createConnection(elementData(semantic, {
      hidden: hidden,
      source: source,
      target: target,
      waypoints: collectWaypoints(di.waypoint)
    }));

    if (is(semantic, 'bpmn:DataAssociation')) {

      // render always on top; this ensures DataAssociations
      // are rendered correctly across different "hacks" people
      // love to model such as cross participant / sub process
      // associations
      parentElement = null;
    }

    // insert sequence flows behind other flow nodes (cf. #727)
    if (is(semantic, 'bpmn:SequenceFlow')) {
      parentIndex = 0;
    }

    this._canvas.addConnection(element, parentElement, parentIndex);
  } else {
    throw new Error(translate('unknown di {di} for element {semantic}', {
      di: elementToString(di),
      semantic: elementToString(semantic)
    }));
  }
  // (optional) LABEL
  if (isLabelExternal(semantic) && semantic.name) {
    this.addLabel(semantic, element);
  }


  this._eventBus.fire('bpmnElement.added', { element: element });

  return element;
};


/**
 * Attach the boundary element to the given host
 *
 * @param {ModdleElement} boundarySemantic
 * @param {djs.model.Base} boundaryElement
 */
ChoreoImporter.prototype._attachBoundary = function(boundarySemantic, boundaryElement) {
  var translate = this._translate;
  var hostSemantic = boundarySemantic.attachedToRef;

  if (!hostSemantic) {
    throw new Error(translate('missing {semantic}#attachedToRef', {
      semantic: elementToString(boundarySemantic)
    }));
  }

  var host = this._elementRegistry.get(hostSemantic.id),
      attachers = host && host.attachers;

  if (!host) {
    throw notYetDrawn(translate, boundarySemantic, hostSemantic, 'attachedToRef');
  }

  // wire element.host <> host.attachers
  boundaryElement.host = host;

  if (!attachers) {
    host.attachers = attachers = [];
  }

  if (attachers.indexOf(boundaryElement) === -1) {
    attachers.push(boundaryElement);
  }
};


/**
 * add label for an element
 */
ChoreoImporter.prototype.addLabel = function(semantic, element) {
  var bounds,
      text,
      label;

  bounds = getExternalLabelBounds(semantic, element);

  text = semantic.name;

  if (text) {
    // get corrected bounds from actual layouted text
    bounds = this._textRenderer.getExternalLabelBounds(bounds, text);
  }

  label = this._elementFactory.createLabel(elementData(semantic, {
    id: semantic.id + '_label',
    labelTarget: element,
    type: 'label',
    hidden: element.hidden || !semantic.name,
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height)
  }));

  return this._canvas.addShape(label, element.parent);
};

/**
 * Return the drawn connection end based on the given side.
 *
 * @throws {Error} if the end is not yet drawn
 */
ChoreoImporter.prototype._getEnd = function(semantic, side) {

  var element,
      refSemantic,
      type = semantic.$type,
      translate = this._translate;

  refSemantic = semantic[side + 'Ref'];

  // handle mysterious isMany DataAssociation#sourceRef
  if (side === 'source' && type === 'bpmn:DataInputAssociation') {
    refSemantic = refSemantic && refSemantic[0];
  }

  // fix source / target for DataInputAssociation / DataOutputAssociation
  if (side === 'source' && type === 'bpmn:DataOutputAssociation' ||
      side === 'target' && type === 'bpmn:DataInputAssociation') {

    refSemantic = semantic.$parent;
  }

  element = refSemantic && this._getElement(refSemantic);

  if (element) {
    return element;
  }

  if (refSemantic) {
    throw notYetDrawn(translate, semantic, refSemantic, side + 'Ref');
  } else {
    throw new Error(translate('{semantic}#{side} Ref not specified', {
      semantic: elementToString(semantic),
      side: side
    }));
  }
};

ChoreoImporter.prototype._getSource = function(semantic) {
  return this._getEnd(semantic, 'source');
};

ChoreoImporter.prototype._getTarget = function(semantic) {
  return this._getEnd(semantic, 'target');
};


ChoreoImporter.prototype._getElement = function(semantic) {
  return this._elementRegistry.get(semantic.id);
};


// helpers ////////////////////

function isPointInsideBBox(bbox, point) {
  var x = point.x,
      y = point.y;

  return x >= bbox.x &&
    x <= bbox.x + bbox.width &&
    y >= bbox.y &&
    y <= bbox.y + bbox.height;
}