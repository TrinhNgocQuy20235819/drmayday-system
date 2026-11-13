const patientFlowService = require('./patientFlow.service');
const patientService = require('./patient.service');
const templateSeed = require('./templateSeed.service');
const { successResponse, errorResponse } = require('../../common/response');

function handleErr(res, next, err) {
  if (err && err.code) {
    return errorResponse(res, err.message, err.statusCode || 400, err.code);
  }
  return next(err);
}

class PatientFlowController {
  // ---- Red Flag Screening ----
  async submitRedFlag(req, res, next) {
    try {
      const data = await patientFlowService.submitRedFlagScreening(req.user, req.body);
      return successResponse(res, data, 'Ghi nhận sàng lọc báo động đỏ thành công', 201);
    } catch (err) {
      return handleErr(res, next, err);
    }
  }

  async listRedFlags(req, res, next) {
    try {
      const data = await patientFlowService.getRedFlagScreenings(req.user, req.query);
      return successResponse(res, data, 'Lấy lịch sử sàng lọc thành công');
    } catch (err) {
      return handleErr(res, next, err);
    }
  }

  async getRedFlagById(req, res, next) {
    try {
      const data = await patientFlowService.getRedFlagScreeningById(req.user, req.params.id);
      return successResponse(res, data, 'Lấy chi tiết lượt sàng lọc thành công');
    } catch (err) {
      return handleErr(res, next, err);
    }
  }

  // ---- Templates (Sub DB) ----
  async listTemplates(req, res, next) {
    try {
      const data = await templateSeed.listTemplates();
      return successResponse(res, data, 'Lấy danh sách mẫu bệnh án thành công');
    } catch (err) {
      return handleErr(res, next, err);
    }
  }

  async getTemplate(req, res, next) {
    try {
      const data = await templateSeed.getTemplateByIdOrCode(req.params.id);
      if (!data) {
        return errorResponse(res, `Không tìm thấy mẫu bệnh án #${req.params.id}`, 404, 3007);
      }
      return successResponse(res, data, 'Lấy mẫu bệnh án thành công');
    } catch (err) {
      return handleErr(res, next, err);
    }
  }

  // ---- Medical Records ----
  async getClassifyQuestions(req, res, next) {
    try {
      const data = patientFlowService.getClassifyQuestions();
      return successResponse(res, data, 'Lấy bộ câu hỏi phân loại bệnh án thành công');
    } catch (err) {
      return handleErr(res, next, err);
    }
  }

  async classifyRecord(req, res, next) {
    try {
      const data = await patientFlowService.classifyMedicalRecord(req.body);
      return successResponse(res, data, 'Phân loại hồ sơ bệnh án thành công');
    } catch (err) {
      return handleErr(res, next, err);
    }
  }

  async getPatientRecordHistory(req, res, next) {
    try {
      const pid = req.params.patientId;
      await patientService.assertPatientAccess(req.user, pid);
      const data = await patientService.getHoSoBenhAnByPatientId(pid);
      return successResponse(res, data, `Lấy lịch sử hồ sơ bệnh án của bệnh nhân #${pid} thành công`);
    } catch (err) {
      return handleErr(res, next, err);
    }
  }

  async createRecord(req, res, next) {
    try {
      const data = await patientFlowService.createMedicalRecord(req.user, req.body);
      return successResponse(res, data, 'Tạo hồ sơ bệnh án thành công', 201);
    } catch (err) {
      return handleErr(res, next, err);
    }
  }

  async listRecords(req, res, next) {
    try {
      const data = await patientFlowService.listMedicalRecords(req.user, req.query);
      return successResponse(res, data, 'Lấy danh sách hồ sơ bệnh án thành công');
    } catch (err) {
      return handleErr(res, next, err);
    }
  }

  async getRecordDetail(req, res, next) {
    try {
      const data = await patientFlowService.getMedicalRecordDetail(req.user, req.params.id);
      return successResponse(res, data, 'Lấy chi tiết hồ sơ bệnh án thành công');
    } catch (err) {
      return handleErr(res, next, err);
    }
  }

  async updateRecord(req, res, next) {
    try {
      const data = await patientFlowService.updateMedicalRecord(req.user, req.params.id, req.body);
      return successResponse(res, data, 'Cập nhật hồ sơ bệnh án thành công');
    } catch (err) {
      return handleErr(res, next, err);
    }
  }

  async upsertAnswers(req, res, next) {
    try {
      const data = await patientFlowService.upsertRecordAnswers(req.user, req.params.id, req.body);
      return successResponse(res, data, 'Lưu câu trả lời bệnh án thành công');
    } catch (err) {
      return handleErr(res, next, err);
    }
  }

  async getAnswers(req, res, next) {
    try {
      const data = await patientFlowService.getRecordAnswers(req.user, req.params.id);
      return successResponse(res, data, 'Lấy danh sách câu trả lời bệnh án thành công');
    } catch (err) {
      return handleErr(res, next, err);
    }
  }

  async getRecordSummary(req, res, next) {
    try {
      const data = await patientFlowService.getMedicalRecordSummary(req.user, req.params.id);
      return successResponse(res, data, 'Lấy tổng hợp hồ sơ bệnh án thành công');
    } catch (err) {
      return handleErr(res, next, err);
    }
  }

  async getRecordHistory(req, res, next) {
    try {
      const data = await patientFlowService.getMedicalRecordHistory(req.user, req.params.id);
      return successResponse(res, data, 'Lấy lịch sử hồ sơ bệnh án thành công');
    } catch (err) {
      return handleErr(res, next, err);
    }
  }

  async closeRecord(req, res, next) {
    try {
      const data = await patientFlowService.closeMedicalRecord(req.user, req.params.id);
      return successResponse(res, data, 'Đã gửi và đóng hồ sơ chờ bác sĩ tiếp nhận');
    } catch (err) {
      return handleErr(res, next, err);
    }
  }

  async acceptRecord(req, res, next) {
    try {
      const data = await patientFlowService.acceptMedicalRecord(req.user, req.params.id, req.body);
      return successResponse(res, data, 'Bác sĩ đã tiếp nhận hồ sơ bệnh án');
    } catch (err) {
      return handleErr(res, next, err);
    }
  }

  async completeRecord(req, res, next) {
    try {
      const data = await patientFlowService.completeMedicalRecord(req.user, req.params.id, req.body);
      return successResponse(res, data, 'Đã hoàn tất hồ sơ bệnh án');
    } catch (err) {
      return handleErr(res, next, err);
    }
  }

  async deleteRecord(req, res, next) {
    try {
      const data = await patientFlowService.deleteMedicalRecord(req.user, req.params.id);
      return successResponse(res, data, 'Đã xóa hồ sơ bệnh án thành công');
    } catch (err) {
      return handleErr(res, next, err);
    }
  }

  async getRecordSessions(req, res, next) {
    try {
      await patientFlowService.getMedicalRecordDetail(req.user, req.params.id);
      const data = await patientService.getPhienKhamList(req.params.id);
      return successResponse(res, data, 'Lấy danh sách phiên khám thành công');
    } catch (err) {
      return handleErr(res, next, err);
    }
  }

  async createRecordSession(req, res, next) {
    try {
      const data = await patientService.createPhienKham(req.params.id, req.body, req.user);
      return successResponse(res, data, 'Tạo phiên khám mới thành công', 201);
    } catch (err) {
      return handleErr(res, next, err);
    }
  }

  // ---- Lab Results & Prescriptions ----
  async createLabResult(req, res, next) {
    try {
      const data = await patientFlowService.createLabResult(req.user, req.body);
      return successResponse(res, data, 'Lưu kết quả cận lâm sàng thành công', 201);
    } catch (err) {
      return handleErr(res, next, err);
    }
  }

  async getLabResults(req, res, next) {
    try {
      const rid = req.params.recordId || req.params.id || req.query.medical_record_id;
      const data = await patientFlowService.getLabResultsByRecord(req.user, rid);
      return successResponse(res, data, 'Lấy kết quả cận lâm sàng thành công');
    } catch (err) {
      return handleErr(res, next, err);
    }
  }

  async createPrescription(req, res, next) {
    try {
      const data = await patientFlowService.createPrescription(req.user, req.body);
      return successResponse(res, data, 'Kê đơn thuốc thành công', 201);
    } catch (err) {
      return handleErr(res, next, err);
    }
  }

  async getPrescriptions(req, res, next) {
    try {
      const rid = req.params.recordId || req.params.id || req.query.medical_record_id;
      const data = await patientFlowService.getPrescriptionsByRecord(req.user, rid);
      return successResponse(res, data, 'Lấy danh sách đơn thuốc thành công');
    } catch (err) {
      return handleErr(res, next, err);
    }
  }

  // ---- UAS7 & AAS ----
  async checkUas7Eligibility(req, res, next) {
    try {
      const query = { ...req.query };
      if (req.params.patientId) query.patient_id = req.params.patientId;
      const data = await patientFlowService.checkUas7Eligibility(req.user, query);
      return successResponse(res, data, 'Kiểm tra điều kiện theo dõi UAS7 thành công');
    } catch (err) {
      return handleErr(res, next, err);
    }
  }

  async logUas7(req, res, next) {
    try {
      const data = await patientFlowService.logUas7Score(req.user, req.body);
      return successResponse(res, data, 'Ghi nhận điểm UAS7 hàng ngày thành công', 201);
    } catch (err) {
      return handleErr(res, next, err);
    }
  }

  async getUas7(req, res, next) {
    try {
      const query = { ...req.query };
      if (req.params.patientId) query.patient_id = req.params.patientId;
      const data = await patientFlowService.getUas7Scores(req.user, query);
      return successResponse(res, data, 'Lấy dữ liệu theo dõi UAS7 thành công');
    } catch (err) {
      return handleErr(res, next, err);
    }
  }

  async logAas(req, res, next) {
    try {
      const data = await patientFlowService.logAasScore(req.user, req.body);
      return successResponse(res, data, 'Ghi nhận điểm AAS hàng ngày thành công', 201);
    } catch (err) {
      return handleErr(res, next, err);
    }
  }

  async getAas(req, res, next) {
    try {
      const data = await patientFlowService.getAasScores(req.user, req.query);
      return successResponse(res, data, 'Lấy dữ liệu theo dõi AAS thành công');
    } catch (err) {
      return handleErr(res, next, err);
    }
  }

  // ---- Lesion Episodes, Locations, Photos, Supabase Attachments, Answer Images ----
  async createEpisode(req, res, next) {
    try {
      const data = await patientFlowService.createLesionEpisode(req.user, req.body);
      return successResponse(res, data, 'Tạo đợt tổn thương da thành công', 201);
    } catch (err) {
      return handleErr(res, next, err);
    }
  }

  async listEpisodes(req, res, next) {
    try {
      const data = await patientFlowService.getLesionEpisodes(req.user, req.query);
      return successResponse(res, data, 'Lấy danh sách đợt tổn thương thành công');
    } catch (err) {
      return handleErr(res, next, err);
    }
  }

  async getEpisodeById(req, res, next) {
    try {
      const data = await patientFlowService.getLesionEpisodeById(req.user, req.params.id);
      return successResponse(res, data, 'Lấy chi tiết đợt tổn thương thành công');
    } catch (err) {
      return handleErr(res, next, err);
    }
  }

  async updateEpisode(req, res, next) {
    try {
      const data = await patientFlowService.updateLesionEpisode(req.user, req.params.id, req.body);
      return successResponse(res, data, 'Cập nhật đợt tổn thương thành công');
    } catch (err) {
      return handleErr(res, next, err);
    }
  }

  async deleteEpisode(req, res, next) {
    try {
      const data = await patientFlowService.deleteLesionEpisode(req.user, req.params.id);
      return successResponse(res, data, 'Đã xóa đợt tổn thương');
    } catch (err) {
      return handleErr(res, next, err);
    }
  }

  async createLocation(req, res, next) {
    try {
      const data = await patientFlowService.createLesionLocation(req.user, req.body);
      return successResponse(res, data, 'Thêm vị trí tổn thương thành công', 201);
    } catch (err) {
      return handleErr(res, next, err);
    }
  }

  async listLocations(req, res, next) {
    try {
      const query = { ...req.query };
      if (req.params.episodeId) query.episode_id = req.params.episodeId;
      const data = await patientFlowService.getLesionLocations(req.user, query);
      return successResponse(res, data, 'Lấy danh sách vị trí tổn thương thành công');
    } catch (err) {
      return handleErr(res, next, err);
    }
  }

  async updateLocation(req, res, next) {
    try {
      const data = await patientFlowService.updateLesionLocation(req.user, req.params.id, req.body);
      return successResponse(res, data, 'Cập nhật vị trí tổn thương thành công');
    } catch (err) {
      return handleErr(res, next, err);
    }
  }

  async deleteLocation(req, res, next) {
    try {
      const data = await patientFlowService.deleteLesionLocation(req.user, req.params.id);
      return successResponse(res, data, 'Đã xóa vị trí tổn thương');
    } catch (err) {
      return handleErr(res, next, err);
    }
  }

  async uploadAttachment(req, res, next) {
    try {
      const data = await patientFlowService.uploadAttachmentToSupabase(req.user, req.file, req.body);
      return successResponse(res, data, 'Upload ảnh lên Supabase Storage thành công', 201);
    } catch (err) {
      return handleErr(res, next, err);
    }
  }

  async listAttachments(req, res, next) {
    try {
      const query = { ...req.query };
      if (req.params.userId) query.user_id = req.params.userId;
      const data = await patientFlowService.listAttachments(req.user, query);
      return successResponse(res, data, 'Lấy danh sách tệp đính kèm thành công');
    } catch (err) {
      return handleErr(res, next, err);
    }
  }

  async deleteAttachment(req, res, next) {
    try {
      const data = await patientFlowService.deleteAttachment(req.user, req.params.id);
      return successResponse(res, data, 'Đã xóa tệp đính kèm trên Storage và DB');
    } catch (err) {
      return handleErr(res, next, err);
    }
  }

  async createPhoto(req, res, next) {
    try {
      const data = await patientFlowService.createLesionPhoto(req.user, req.body);
      return successResponse(res, data, 'Lưu ảnh tổn thương thành công', 201);
    } catch (err) {
      return handleErr(res, next, err);
    }
  }

  async listPhotos(req, res, next) {
    try {
      const query = { ...req.query };
      if (req.params.locationId) query.location_id = req.params.locationId;
      const data = await patientFlowService.getLesionPhotos(req.user, query);
      return successResponse(res, data, 'Lấy danh sách ảnh tổn thương thành công');
    } catch (err) {
      return handleErr(res, next, err);
    }
  }

  async updatePhotoMilestone(req, res, next) {
    try {
      const data = await patientFlowService.updateLesionPhotoMilestone(req.user, req.params.id, req.body);
      return successResponse(res, data, 'Cập nhật mốc tiến triển ảnh tổn thương thành công');
    } catch (err) {
      return handleErr(res, next, err);
    }
  }

  async deletePhoto(req, res, next) {
    try {
      const data = await patientFlowService.deleteLesionPhoto(req.user, req.params.id);
      return successResponse(res, data, 'Đã xóa ảnh tổn thương');
    } catch (err) {
      return handleErr(res, next, err);
    }
  }

  async attachAnswerImage(req, res, next) {
    try {
      const data = await patientFlowService.attachAnswerImage(req.user, req.body);
      return successResponse(res, data, 'Gắn ảnh vào câu trả lời thành công', 201);
    } catch (err) {
      return handleErr(res, next, err);
    }
  }

  async listAnswerImages(req, res, next) {
    try {
      const query = { ...req.query };
      if (req.params.answerId) query.answer_id = req.params.answerId;
      const data = await patientFlowService.getAnswerImages(req.user, query);
      return successResponse(res, data, 'Lấy danh sách ảnh câu trả lời thành công');
    } catch (err) {
      return handleErr(res, next, err);
    }
  }

  async deleteAnswerImage(req, res, next) {
    try {
      const data = await patientFlowService.deleteAnswerImage(req.user, req.params.id);
      return successResponse(res, data, 'Đã xóa ảnh gắn câu trả lời');
    } catch (err) {
      return handleErr(res, next, err);
    }
  }
}

module.exports = new PatientFlowController();

