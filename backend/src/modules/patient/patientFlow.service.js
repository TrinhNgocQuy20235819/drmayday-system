const crypto = require('crypto');
const path = require('path');
const db = require('../../config/db');
const prisma = require('../../config/prisma');
const { supabase, bucketName, isConfigured } = require('../../config/supabase');
const patientService = require('./patient.service');
const templateSeed = require('./templateSeed.service');
const {
  createAppError,
  isStaffRole,
  resolvePatientIdForUser,
} = require('./patient.helpers');

/**
 * Service hợp nhất toàn bộ quy trình Bệnh nhân (Slides 1, 2, 5, 6, 7, 8, 9, 11):
 * - Sàng lọc báo động đỏ (sanglocbaodongdo)
 * - Hồ sơ bệnh án động + Q&A + Vòng đời (hosobenhan + Sub DB)
 * - Cận lâm sàng & Đơn thuốc (ketquacanlamsang, donthuoc, chitietdonthuoc)
 * - Theo dõi UAS7 & AAS (chukytheodoiuas7, nhatkyuashangngay, nhatkyaashangngay + Sub DB)
 * - Đợt & Vị trí tổn thương + Ảnh + Upload Supabase Storage mayday-attachments
 */
class PatientFlowService {
  // ============================================================================
  // 1. SÀNG LỌC BÁO ĐỘNG ĐỎ (Red Flag Screening)
  // ============================================================================
  async submitRedFlagScreening(user, data = {}) {
    let maBenhNhan = data.ma_benh_nhan || data.patient_id || null;
    if (!isStaffRole(user)) {
      maBenhNhan = await resolvePatientIdForUser(db, user);
    } else if (maBenhNhan) {
      maBenhNhan = parseInt(maBenhNhan, 10);
    }

    const khoTho = Boolean(
      data.co_kho_tho_kho_khe_nghen_hong ?? data.difficulty_breathing ?? data.shortness_of_breath ?? false
    );
    const chongMat = Boolean(
      data.co_chong_mat_tuc_nguc_sap_ngat ?? data.dizziness_fainting ?? data.chest_tightness ?? false
    );
    const sungMoi = Boolean(
      data.co_sung_moi_luoi_co_hong ?? data.swelling_lips_tongue_throat ?? data.angioedema_airway ?? false
    );
    const dauBung = Boolean(
      data.co_dau_bung_non_lien_tuc ?? data.severe_abdominal_pain_vomiting ?? false
    );

    const hasRisk = khoTho || chongMat || sungMoi || dauBung;

    // Tuân thủ ck_sanglocbaodongdo_xac_nhan & ck_sanglocbaodongdo_goi_cap_cuu
    const wantCall = hasRisk
      ? Boolean(data.xac_nhan_muon_goi_cap_cuu ?? data.confirm_emergency_call ?? data.called_emergency ?? false)
      : null;
    const pressedCallBtn = hasRisk && wantCall === true && Boolean(data.da_nhan_nut_goi_cap_cuu ?? data.pressed_call_button ?? false);
    const emergencyPhone = pressedCallBtn
      ? String(data.so_dien_thoai_cap_cuu || data.emergency_phone || '115').trim()
      : null;
    const pressedAt = pressedCallBtn ? new Date() : null;

    const query = `
      INSERT INTO public.sanglocbaodongdo (
        ma_benh_nhan,
        phien_ban_bo_cau_hoi,
        co_kho_tho_kho_khe_nghen_hong,
        co_chong_mat_tuc_nguc_sap_ngat,
        co_sung_moi_luoi_co_hong,
        co_dau_bung_non_lien_tuc,
        xac_nhan_muon_goi_cap_cuu,
        da_nhan_nut_goi_cap_cuu,
        so_dien_thoai_cap_cuu,
        thoi_diem_nhan_nut_goi
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *
    `;
    const res = await db.query(query, [
      maBenhNhan,
      String(data.phien_ban_bo_cau_hoi || 'APP_GD1_V1'),
      khoTho,
      chongMat,
      sungMoi,
      dauBung,
      wantCall,
      pressedCallBtn,
      emergencyPhone,
      pressedAt,
    ]);

    const row = res.rows[0];
    return {
      ...row,
      ma_luot_sang_loc: Number(row.ma_luot_sang_loc),
      ma_benh_nhan: row.ma_benh_nhan ? Number(row.ma_benh_nhan) : null,
      id: Number(row.ma_luot_sang_loc),
      has_red_flag: row.co_nguy_co_phan_ve,
      recommendation: row.co_nguy_co_phan_ve
        ? 'CẢNH BÁO ĐỎ: Có dấu hiệu nghi ngờ phản vệ/phù thanh quản. Cần gọi cấp cứu 115 hoặc tới cơ sở y tế gần nhất ngay!'
        : 'An toàn: Không ghi nhận dấu hiệu báo động đỏ. Có thể tiếp tục phân loại & lập hồ sơ bệnh án.',
    };
  }

  async getRedFlagScreenings(user, queryParams = {}) {
    let targetPatientId = queryParams.patient_id || queryParams.ma_benh_nhan || null;
    if (!isStaffRole(user)) {
      targetPatientId = await resolvePatientIdForUser(db, user);
    }

    const params = [];
    let where = '';
    if (targetPatientId) {
      params.push(parseInt(targetPatientId, 10));
      where = 'WHERE s.ma_benh_nhan = $1';
    }

    const res = await db.query(
      `SELECT s.*, ng.ho_ten AS ten_benh_nhan
       FROM public.sanglocbaodongdo s
       LEFT JOIN public.nguoi ng ON s.ma_benh_nhan = ng.ma_nguoi
       ${where}
       ORDER BY s.ma_luot_sang_loc DESC
       LIMIT 100`,
      params
    );
    return res.rows.map((r) => ({
      ...r,
      ma_luot_sang_loc: Number(r.ma_luot_sang_loc),
      ma_benh_nhan: r.ma_benh_nhan ? Number(r.ma_benh_nhan) : null,
    }));
  }

  async getRedFlagScreeningById(user, screeningId) {
    const id = parseInt(screeningId, 10);
    const res = await db.query(
      'SELECT * FROM public.sanglocbaodongdo WHERE ma_luot_sang_loc = $1 LIMIT 1',
      [id]
    );
    const row = res.rows[0];
    if (!row) throw createAppError(`Không tìm thấy lượt sàng lọc #${id}`, 3007, 404);
    if (!isStaffRole(user) && row.ma_benh_nhan) {
      await patientService.assertPatientAccess(user, row.ma_benh_nhan);
    }
    return {
      ...row,
      ma_luot_sang_loc: Number(row.ma_luot_sang_loc),
      ma_benh_nhan: row.ma_benh_nhan ? Number(row.ma_benh_nhan) : null,
    };
  }

  // ============================================================================
  // 2. HỒ SƠ BỆNH ÁN MỞ RỘNG (medrec01 -> medrec14)
  // ============================================================================
  getClassifyQuestions() {
    return [
      {
        question_id: 'Q_DURATION_WEEKS',
        question_text: 'Triệu chứng mày đay kéo dài bao lâu?',
        question_type: 'RADIO',
        options: [
          { value: 'LT_6_WEEKS', label: 'Dưới 6 tuần (Mày đay cấp tính)' },
          { value: 'GE_6_WEEKS', label: 'Từ 6 tuần trở lên (Mày đay mạn tính)' },
          { value: 'FOLLOWUP', label: 'Tái khám theo hẹn' },
        ],
      },
    ];
  }

  async classifyMedicalRecord(data = {}) {
    let isFollowup = Boolean(data.is_followup || data.tai_kham || data.has_previous_record);
    let weeks =
      data.duration_weeks !== undefined
        ? Number(data.duration_weeks)
        : data.thoi_gian_khoi_phat_tuan !== undefined
        ? Number(data.thoi_gian_khoi_phat_tuan)
        : data.duration_days !== undefined
        ? Number(data.duration_days) / 7
        : 0;

    if (Array.isArray(data.answers)) {
      for (const ans of data.answers) {
        const val = String(ans.option_value || ans.answer_value || ans.value || '').toUpperCase();
        if (val === 'GE_6_WEEKS' || val === 'CHRONIC' || val === 'MAN') weeks = 6;
        else if (val === 'LT_6_WEEKS' || val === 'ACUTE' || val === 'CAP') weeks = 2;
        else if (val === 'FOLLOWUP' || val === 'TAI_KHAM') isFollowup = true;
      }
    }

    let code = 'TMPL_URTICARIA_ACUTE';
    let subtype = 'URTICARIA_ACUTE';
    let loaiBenhAn = 'CAP';
    let label = 'Mày đay cấp tính (< 6 tuần)';

    if (isFollowup) {
      code = 'TMPL_URTICARIA_FOLLOWUP';
      subtype = 'URTICARIA_FOLLOWUP';
      loaiBenhAn = 'MAN';
      label = 'Phiếu tái khám mày đay';
    } else if (weeks >= 6) {
      code = 'TMPL_URTICARIA_CHRONIC_INIT';
      subtype = 'URTICARIA_CHRONIC_INIT';
      loaiBenhAn = 'MAN';
      label = 'Mày đay mạn tính - Khám lần đầu (>= 6 tuần)';
    }

    const template = await templateSeed.getTemplateByIdOrCode(code);
    return {
      loai_benh_an: loaiBenhAn,
      record_subtype: subtype,
      duration_weeks: weeks,
      template_id: template?.id || (loaiBenhAn === 'CAP' ? 1 : isFollowup ? 3 : 2),
      code_template: code,
      label,
      template,
    };
  }

  async _getRecordOrThrow(recordId, user = null) {
    const rid = parseInt(recordId, 10);
    if (Number.isNaN(rid) || rid <= 0) {
      throw createAppError('Mã hồ sơ bệnh án không hợp lệ', 2003, 400);
    }
    const res = await db.query(
      `SELECT hs.*, ng.ho_ten, ng.so_dien_thoai, ng.gioi_tinh, ng.ngay_sinh
       FROM public.hosobenhan hs
       LEFT JOIN public.nguoi ng ON hs.ma_benh_nhan = ng.ma_nguoi
       WHERE hs.ma_ho_so = $1
       LIMIT 1`,
      [rid]
    );
    const row = res.rows[0];
    if (!row) {
      throw createAppError(`Không tìm thấy hồ sơ bệnh án #${rid}`, 3007, 404);
    }
    if (user && !isStaffRole(user)) {
      await patientService.assertPatientAccess(user, row.ma_benh_nhan);
    }
    return row;
  }

  async createMedicalRecord(user, data = {}) {
    let pid = data.ma_benh_nhan || data.patient_id;
    if (!isStaffRole(user)) {
      pid = await resolvePatientIdForUser(db, user);
    }
    if (!pid) {
      throw createAppError('Không xác định được mã bệnh nhân cho hồ sơ mới', 2001, 400);
    }
    await patientService.assertPatientAccess(user, pid);

    const payload = { ...data, ma_benh_nhan: pid };
    if (!payload.loai_benh_an && (payload.duration_weeks !== undefined || payload.type || payload.record_subtype)) {
      const classified = await this.classifyMedicalRecord(payload);
      payload.loai_benh_an = classified.loai_benh_an;
      payload.record_subtype = payload.record_subtype || classified.record_subtype;
      payload.template_id = payload.template_id || classified.template_id;
    }

    const created = await patientService.createHoSoBenhAn(payload, user);

    if (Array.isArray(data.answers) && data.answers.length > 0) {
      await this.upsertRecordAnswers(user, created.ma_ho_so, data.answers, false);
    }
    return this.getMedicalRecordDetail(user, created.ma_ho_so);
  }

  async listMedicalRecords(user, queryParams = {}) {
    const conditions = [];
    const params = [];

    if (!isStaffRole(user)) {
      const myPid = await resolvePatientIdForUser(db, user);
      if (!myPid) return [];
      params.push(myPid);
      conditions.push(`hs.ma_benh_nhan = $${params.length}`);
    } else if (queryParams.patient_id || queryParams.ma_benh_nhan) {
      params.push(parseInt(queryParams.patient_id || queryParams.ma_benh_nhan, 10));
      conditions.push(`hs.ma_benh_nhan = $${params.length}`);
    }

    if (queryParams.status || queryParams.trang_thai) {
      params.push(String(queryParams.status || queryParams.trang_thai).trim());
      conditions.push(`hs.trang_thai = $${params.length}`);
    }
    if (queryParams.loai_benh_an || queryParams.type) {
      params.push(String(queryParams.loai_benh_an || queryParams.type).trim().toUpperCase());
      conditions.push(`hs.loai_benh_an = $${params.length}`);
    }

    const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.min(Math.max(parseInt(queryParams.limit, 10) || 50, 1), 200);
    params.push(limit);

    const res = await db.query(
      `SELECT hs.*, ng.ho_ten, ng.so_dien_thoai,
              (SELECT COUNT(*)::INT FROM public.phienkham pk WHERE pk.ma_ho_so = hs.ma_ho_so) AS so_phien_kham
       FROM public.hosobenhan hs
       JOIN public.nguoi ng ON hs.ma_benh_nhan = ng.ma_nguoi
       ${whereSql}
       ORDER BY hs.ma_ho_so DESC
       LIMIT $${params.length}`,
      params
    );

    const ids = res.rows.map((r) => BigInt(r.ma_ho_so));
    let metaMap = new Map();
    if (ids.length > 0) {
      try {
        const metas = await prisma.medicalRecordMeta.findMany({
          where: { maHoSo: { in: ids } },
        });
        metaMap = new Map(metas.map((m) => [Number(m.maHoSo), m]));
      } catch {}
    }

    return res.rows.map((r) => {
      const m = metaMap.get(Number(r.ma_ho_so));
      return {
        ...r,
        ma_ho_so: Number(r.ma_ho_so),
        ma_benh_nhan: Number(r.ma_benh_nhan),
        id: Number(r.ma_ho_so),
        thoi_gian_khoi_phat_tuan: r.thoi_gian_khoi_phat_tuan !== null ? Number(r.thoi_gian_khoi_phat_tuan) : null,
        template_id: m?.templateId || (r.loai_benh_an === 'CAP' ? 1 : 2),
        record_subtype: m?.recordSubtype || (r.loai_benh_an === 'CAP' ? 'URTICARIA_ACUTE' : 'URTICARIA_CHRONIC_INIT'),
        ly_do_den_kham: m?.lyDoDenKham || null,
        trieu_chung_chinh: m?.trieuChungChinh || null,
      };
    });
  }

  async getMedicalRecordDetail(user, recordId) {
    const row = await this._getRecordOrThrow(recordId, user);
    const rid = Number(row.ma_ho_so);

    const subtypeTable = row.loai_benh_an === 'CAP' ? 'public.benhanmaydaycap' : 'public.benhanmaydayman';
    const [subtypeRes, sessions, meta, answers, answerImages] = await Promise.all([
      db.query(`SELECT * FROM ${subtypeTable} WHERE ma_ho_so = $1 LIMIT 1`, [rid]),
      patientService.getPhienKhamList(rid),
      prisma.medicalRecordMeta.findUnique({ where: { maHoSo: BigInt(rid) } }).catch(() => null),
      prisma.medicalRecordAnswer.findMany({ where: { maHoSo: BigInt(rid) }, orderBy: { questionId: 'asc' } }).catch(() => []),
      prisma.answerImage.findMany({ where: { maHoSo: BigInt(rid) } }).catch(() => []),
    ]);

    const template = await templateSeed.getTemplateByIdOrCode(
      meta?.templateId || (row.loai_benh_an === 'CAP' ? 1 : 2)
    );

    return {
      ...row,
      ma_ho_so: rid,
      ma_benh_nhan: Number(row.ma_benh_nhan),
      id: rid,
      thoi_gian_khoi_phat_tuan: row.thoi_gian_khoi_phat_tuan !== null ? Number(row.thoi_gian_khoi_phat_tuan) : null,
      subtype_detail: subtypeRes.rows[0] || null,
      template_id: meta?.templateId || template?.id || null,
      record_subtype: meta?.recordSubtype || (row.loai_benh_an === 'CAP' ? 'URTICARIA_ACUTE' : 'URTICARIA_CHRONIC_INIT'),
      ly_do_den_kham: meta?.lyDoDenKham || null,
      trieu_chung_chinh: meta?.trieuChungChinh || null,
      doctor_conclusion: meta?.doctorConclusion || null,
      doctor_notes: meta?.doctorNotes || null,
      locked_at: meta?.lockedAt || null,
      closed_at: meta?.closedAt || null,
      accepted_at: meta?.acceptedAt || null,
      completed_at: meta?.completedAt || null,
      sessions,
      answers: answers.map((a) => ({
        id: a.id,
        question_id: a.questionId,
        answer_value: a.answerValue,
        answer_json: a.answerJson,
        updated_at: a.updatedAt,
      })),
      answer_images: answerImages.map((img) => ({
        id: img.id,
        question_id: img.questionId,
        attachment_id: Number(img.attachmentId),
        public_url: img.publicUrl,
      })),
      template,
    };
  }

  async _ensureRecordEditable(recordRow, user) {
    if (recordRow.trang_thai === 'completed' || recordRow.trang_thai === 'cancelled') {
      throw createAppError('Hồ sơ bệnh án đã hoàn tất/đóng khóa, không thể chỉnh sửa', 4003, 400);
    }
    const meta = await prisma.medicalRecordMeta
      .findUnique({ where: { maHoSo: BigInt(recordRow.ma_ho_so) } })
      .catch(() => null);
    if (meta?.lockedAt && !isStaffRole(user)) {
      throw createAppError('Hồ sơ bệnh án đã khóa sau khi gửi cho bác sĩ', 4003, 400);
    }
    return meta;
  }

  async updateMedicalRecord(user, recordId, data = {}) {
    const row = await this._getRecordOrThrow(recordId, user);
    await this._ensureRecordEditable(row, user);
    const rid = Number(row.ma_ho_so);

    const sets = [];
    const vals = [];
    let idx = 1;
    const pushField = (col, val) => {
      if (val !== undefined) {
        sets.push(`${col} = $${idx++}`);
        vals.push(val);
      }
    };
    pushField('chan_doan_tuyen_truoc', data.chan_doan_tuyen_truoc);
    pushField('chan_doan_ban_dau_phong_kham', data.chan_doan_ban_dau_phong_kham);
    if (data.thoi_gian_khoi_phat_tuan !== undefined) {
      pushField('thoi_gian_khoi_phat_tuan', data.thoi_gian_khoi_phat_tuan === null ? null : Number(data.thoi_gian_khoi_phat_tuan));
    }
    if (data.tien_su_gia_dinh !== undefined && ['Co', 'Khong', 'Khong ro', null].includes(data.tien_su_gia_dinh)) {
      pushField('tien_su_gia_dinh', data.tien_su_gia_dinh);
    }
    pushField('tien_su_gia_dinh_ghi_ro', data.tien_su_gia_dinh_ghi_ro);
    if (data.da_dieu_tri_truoc_kham !== undefined) {
      pushField('da_dieu_tri_truoc_kham', Boolean(data.da_dieu_tri_truoc_kham));
    }
    if (isStaffRole(user) && ['draft', 'pending', 'in_progress', 'completed', 'cancelled'].includes(data.trang_thai)) {
      pushField('trang_thai', data.trang_thai);
    }

    if (sets.length > 0) {
      vals.push(rid);
      await db.query(`UPDATE public.hosobenhan SET ${sets.join(', ')} WHERE ma_ho_so = $${idx}`, vals);
    }

    const metaData = {};
    if (data.ly_do_den_kham !== undefined) metaData.lyDoDenKham = data.ly_do_den_kham;
    if (data.trieu_chung_chinh !== undefined) metaData.trieuChungChinh = data.trieu_chung_chinh;
    if (data.thoi_gian_khoi_phat !== undefined) metaData.thoiGianKhoiPhat = data.thoi_gian_khoi_phat;
    if (isStaffRole(user)) {
      if (data.doctor_conclusion !== undefined) metaData.doctorConclusion = data.doctor_conclusion;
      if (data.doctor_notes !== undefined) metaData.doctorNotes = data.doctor_notes;
    }

    if (Object.keys(metaData).length > 0) {
      await prisma.medicalRecordMeta.upsert({
        where: { maHoSo: BigInt(rid) },
        create: {
          maHoSo: BigInt(rid),
          maBenhNhan: BigInt(row.ma_benh_nhan),
          ...metaData,
        },
        update: metaData,
      });
    }

    if (data.answers) {
      await this.upsertRecordAnswers(user, rid, data.answers, false);
    }

    return this.getMedicalRecordDetail(user, rid);
  }

  async _resolveNumericQuestionId(rawQuestionId) {
    if (typeof rawQuestionId === 'number' && !Number.isNaN(rawQuestionId) && rawQuestionId > 0) {
      return rawQuestionId;
    }
    const rawStr = String(rawQuestionId || '').trim();
    if (/^\d+$/.test(rawStr)) return parseInt(rawStr, 10);
    if (!rawStr) return null;

    const byCode = await prisma.templateQuestion.findFirst({
      where: { questionCode: rawStr },
      select: { id: true },
    });
    if (byCode) return byCode.id;

    // Hash string question_id thành số nguyên dương ổn định để lưu Sub DB (Prisma Int)
    let hash = 0;
    for (let i = 0; i < rawStr.length; i += 1) {
      hash = (hash * 31 + rawStr.charCodeAt(i)) % 2000000000;
    }
    return Math.abs(hash) + 10000;
  }

  async getRecordAnswers(user, recordId) {
    const row = await this._getRecordOrThrow(recordId, user);
    const rid = Number(row.ma_ho_so);
    const answers = await prisma.medicalRecordAnswer.findMany({
      where: { maHoSo: BigInt(rid) },
      orderBy: { questionId: 'asc' },
    });
    return {
      ma_ho_so: rid,
      answers: answers.map((a) => ({
        id: a.id,
        question_id: a.questionId,
        answer_value: a.answerValue,
        answer_json: a.answerJson,
        updated_at: a.updatedAt,
      })),
    };
  }

  async upsertRecordAnswers(user, recordId, rawAnswers, checkLock = true) {
    const row = await this._getRecordOrThrow(recordId, user);
    if (checkLock) {
      await this._ensureRecordEditable(row, user);
    }
    const rid = Number(row.ma_ho_so);

    let list = [];
    if (Array.isArray(rawAnswers)) {
      list = rawAnswers;
    } else if (rawAnswers && Array.isArray(rawAnswers.answers)) {
      list = rawAnswers.answers;
    } else if (rawAnswers && typeof rawAnswers === 'object') {
      list = Object.entries(rawAnswers).map(([k, v]) => ({
        question_id: k,
        answer_value: v,
      }));
    }

    const saved = [];
    for (const item of list) {
      const rawQid = item.question_id || item.questionId;
      const qid = await this._resolveNumericQuestionId(rawQid);
      if (!qid || qid <= 0) continue;

      const rawVal =
        item.answer_value ??
        item.answer_text ??
        item.option_value ??
        item.value ??
        item.answer;
      const isObjOrArr = rawVal !== null && typeof rawVal === 'object';
      const answerValue = isObjOrArr ? JSON.stringify(rawVal) : rawVal !== undefined && rawVal !== null ? String(rawVal) : null;
      const answerJson =
        item.answer_json !== undefined
          ? item.answer_json
          : isObjOrArr
          ? rawVal
          : typeof rawQid === 'string' && !/^\d+$/.test(rawQid)
          ? { question_code: rawQid, value: rawVal }
          : null;

      const upserted = await prisma.medicalRecordAnswer.upsert({
        where: { maHoSo_questionId: { maHoSo: BigInt(rid), questionId: qid } },
        create: {
          maHoSo: BigInt(rid),
          questionId: qid,
          answerValue,
          answerJson: answerJson ?? undefined,
          answeredBy: user?.ma_tai_khoan ? BigInt(user.ma_tai_khoan) : null,
        },
        update: {
          answerValue,
          answerJson: answerJson ?? undefined,
          answeredBy: user?.ma_tai_khoan ? BigInt(user.ma_tai_khoan) : null,
        },
      });
      saved.push({
        id: upserted.id,
        question_id: upserted.questionId,
        answer_value: upserted.answerValue,
        answer_json: upserted.answerJson,
      });
    }

    return {
      ma_ho_so: rid,
      saved_count: saved.length,
      answers: saved,
    };
  }

  async getMedicalRecordSummary(user, recordId) {
    const detail = await this.getMedicalRecordDetail(user, recordId);
    const [patient, labs, prescriptions, episodes, uasRes] = await Promise.all([
      patientService.getBenhNhanById(detail.ma_benh_nhan, false),
      this.getLabResultsByRecord(user, detail.ma_ho_so),
      this.getPrescriptionsByRecord(user, detail.ma_ho_so),
      this.getLesionEpisodes(user, { medical_record_id: detail.ma_ho_so }),
      this.getUas7Scores(user, { patient_id: detail.ma_benh_nhan }),
    ]);

    return {
      record: detail,
      patient,
      lab_results: labs,
      prescriptions,
      lesion_episodes: episodes,
      uas7_summary: uasRes.summary,
    };
  }

  async getMedicalRecordHistory(user, recordId) {
    const row = await this._getRecordOrThrow(recordId, user);
    const rid = Number(row.ma_ho_so);
    const [sessions, meta] = await Promise.all([
      patientService.getPhienKhamList(rid),
      prisma.medicalRecordMeta.findUnique({ where: { maHoSo: BigInt(rid) } }).catch(() => null),
    ]);

    const timeline = [];
    if (row.thoi_diem_kham_lan_dau) {
      timeline.push({ event: 'CREATED', timestamp: row.thoi_diem_kham_lan_dau, detail: `Tạo hồ sơ ${row.loai_benh_an}` });
    }
    if (meta?.closedAt) {
      timeline.push({ event: 'CLOSED_BY_PATIENT', timestamp: meta.closedAt, detail: 'Bệnh nhân gửi/đóng hồ sơ chờ khám' });
    }
    if (meta?.acceptedAt) {
      timeline.push({ event: 'ACCEPTED_BY_DOCTOR', timestamp: meta.acceptedAt, detail: 'Bác sĩ tiếp nhận hồ sơ' });
    }
    for (const s of sessions) {
      timeline.push({
        event: `SESSION_${s.lan_kham_thu}`,
        timestamp: s.ngay_kham,
        detail: s.tom_tat_buoi_kham || `Phiên khám lần ${s.lan_kham_thu}`,
      });
    }
    if (meta?.completedAt) {
      timeline.push({ event: 'COMPLETED', timestamp: meta.completedAt, detail: meta.doctorConclusion || 'Hoàn tất hồ sơ' });
    }

    return {
      ma_ho_so: rid,
      trang_thai: row.trang_thai,
      timeline,
      sessions,
    };
  }

  async closeMedicalRecord(user, recordId) {
    const row = await this._getRecordOrThrow(recordId, user);
    if (row.trang_thai === 'completed') {
      throw createAppError('Hồ sơ đã hoàn tất trước đó', 4003, 400);
    }
    const rid = Number(row.ma_ho_so);
    await db.query(`UPDATE public.hosobenhan SET trang_thai = 'pending' WHERE ma_ho_so = $1`, [rid]);

    const now = new Date();
    await prisma.medicalRecordMeta.upsert({
      where: { maHoSo: BigInt(rid) },
      create: {
        maHoSo: BigInt(rid),
        maBenhNhan: BigInt(row.ma_benh_nhan),
        closedAt: now,
        closedBy: user?.ma_tai_khoan ? BigInt(user.ma_tai_khoan) : null,
        lockedAt: now,
      },
      update: {
        closedAt: now,
        closedBy: user?.ma_tai_khoan ? BigInt(user.ma_tai_khoan) : null,
        lockedAt: now,
      },
    });
    return this.getMedicalRecordDetail(user, rid);
  }

  async acceptMedicalRecord(user, recordId, data = {}) {
    const row = await this._getRecordOrThrow(recordId, user);
    if (row.trang_thai === 'completed') {
      throw createAppError('Hồ sơ đã hoàn tất, không thể tiếp nhận lại', 4003, 400);
    }
    const rid = Number(row.ma_ho_so);
    await db.query(`UPDATE public.hosobenhan SET trang_thai = 'in_progress' WHERE ma_ho_so = $1`, [rid]);

    const existingSessions = await patientService.getPhienKhamList(rid);
    let session = existingSessions[0] || null;
    if (!session) {
      session = await patientService.createPhienKham(rid, data, user);
    }

    await prisma.medicalRecordMeta.upsert({
      where: { maHoSo: BigInt(rid) },
      create: {
        maHoSo: BigInt(rid),
        maBenhNhan: BigInt(row.ma_benh_nhan),
        acceptedAt: new Date(),
        acceptedBy: user?.ma_tai_khoan ? BigInt(user.ma_tai_khoan) : null,
        assignedDoctorId: user?.ma_nguoi ? BigInt(user.ma_nguoi) : null,
      },
      update: {
        acceptedAt: new Date(),
        acceptedBy: user?.ma_tai_khoan ? BigInt(user.ma_tai_khoan) : null,
        assignedDoctorId: user?.ma_nguoi ? BigInt(user.ma_nguoi) : null,
      },
    });

    const detail = await this.getMedicalRecordDetail(user, rid);
    return { ...detail, active_session: session };
  }

  async completeMedicalRecord(user, recordId, data = {}) {
    const row = await this._getRecordOrThrow(recordId, user);
    const rid = Number(row.ma_ho_so);
    await db.query(
      `UPDATE public.hosobenhan
       SET trang_thai = 'completed',
           chan_doan_ban_dau_phong_kham = COALESCE($1, chan_doan_ban_dau_phong_kham),
           ngay_ket_thuc_dieu_tri_ngoai_tru = COALESCE($2, CURRENT_DATE)
       WHERE ma_ho_so = $3`,
      [data.chan_doan_ban_dau_phong_kham || data.doctor_conclusion || null, data.ngay_ket_thuc_dieu_tri_ngoai_tru || null, rid]
    );

    const now = new Date();
    await prisma.medicalRecordMeta.upsert({
      where: { maHoSo: BigInt(rid) },
      create: {
        maHoSo: BigInt(rid),
        maBenhNhan: BigInt(row.ma_benh_nhan),
        doctorConclusion: data.doctor_conclusion || data.conclusion || null,
        doctorNotes: data.doctor_notes || data.notes || null,
        completedAt: now,
        completedBy: user?.ma_tai_khoan ? BigInt(user.ma_tai_khoan) : null,
        lockedAt: now,
      },
      update: {
        doctorConclusion: data.doctor_conclusion || data.conclusion || undefined,
        doctorNotes: data.doctor_notes || data.notes || undefined,
        completedAt: now,
        completedBy: user?.ma_tai_khoan ? BigInt(user.ma_tai_khoan) : null,
        lockedAt: now,
      },
    });

    return this.getMedicalRecordDetail(user, rid);
  }

  async deleteMedicalRecord(user, recordId) {
    const row = await this._getRecordOrThrow(recordId, user);
    const rid = Number(row.ma_ho_so);
    if (row.trang_thai === 'completed' && String(user?.vai_tro || '').toLowerCase() !== 'admin') {
      throw createAppError('Chỉ Admin mới có quyền xóa hồ sơ đã hoàn tất', 3102, 403);
    }

    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET CONSTRAINTS ALL DEFERRED');

      const sessionIdsRes = await client.query('SELECT ma_phien_kham FROM public.phienkham WHERE ma_ho_so = $1', [rid]);
      const sessionIds = sessionIdsRes.rows.map((r) => r.ma_phien_kham);

      const dotIdsRes = await client.query('SELECT ma_dot_ton_thuong_da FROM public.dottonthuongda WHERE ma_ho_so_man = $1', [rid]);
      const dotIds = dotIdsRes.rows.map((r) => r.ma_dot_ton_thuong_da);

      const tepIdsRes = await client.query('SELECT ma_tep_dinh_kem FROM public.tepdinhkem WHERE ma_ho_so = $1', [rid]);
      const tepIds = tepIdsRes.rows.map((r) => r.ma_tep_dinh_kem);

      if (dotIds.length > 0 || tepIds.length > 0) {
        await client.query(
          `DELETE FROM public.anhchuptonthuong
           WHERE ($1::bigint[] IS NOT NULL AND ma_dot_ton_thuong_da = ANY($1))
              OR ($2::bigint[] IS NOT NULL AND ma_tep_dinh_kem = ANY($2))`,
          [dotIds.length ? dotIds : null, tepIds.length ? tepIds : null]
        );
      }
      if (dotIds.length > 0) {
        await client.query('DELETE FROM public.vitritonthuong WHERE ma_dot_ton_thuong_da = ANY($1)', [dotIds]);
        await client.query('DELETE FROM public.dottonthuongda WHERE ma_dot_ton_thuong_da = ANY($1)', [dotIds]);
      }
      if (tepIds.length > 0) {
        await client.query('DELETE FROM public.tepdinhkem WHERE ma_tep_dinh_kem = ANY($1)', [tepIds]);
      }

      const dtRes = await client.query('SELECT ma_don_thuoc FROM public.donthuoc WHERE ma_ho_so = $1', [rid]);
      const dtIds = dtRes.rows.map((r) => r.ma_don_thuoc);
      if (dtIds.length > 0) {
        await client.query('DELETE FROM public.chidanngungthuoc WHERE ma_don_thuoc = ANY($1)', [dtIds]);
        await client.query('DELETE FROM public.chitietdonthuoc WHERE ma_don_thuoc = ANY($1)', [dtIds]);
        await client.query('DELETE FROM public.donthuoc WHERE ma_don_thuoc = ANY($1)', [dtIds]);
      }

      await client.query('DELETE FROM public.nhatkyuashangngay WHERE ma_ho_so_man = $1', [rid]);
      await client.query('DELETE FROM public.nhatkyaashangngay WHERE ma_ho_so_man = $1', [rid]);

      if (sessionIds.length > 0) {
        await client.query('DELETE FROM public.ketquacanlamsang WHERE ma_phien_kham = ANY($1)', [sessionIds]);
        await client.query('DELETE FROM public.ketquaproms WHERE ma_phien_kham_man = ANY($1)', [sessionIds]);
        await client.query('DELETE FROM public.phienkhamcap WHERE ma_phien_kham = ANY($1)', [sessionIds]);
        await client.query('DELETE FROM public.phienkhamman WHERE ma_phien_kham = ANY($1)', [sessionIds]);
        await client.query('DELETE FROM public.phienkham WHERE ma_phien_kham = ANY($1)', [sessionIds]);
      }

      await client.query('DELETE FROM public.tiensubanthan WHERE ma_ho_so = $1', [rid]);
      await client.query('DELETE FROM public.hoancanhkhoiphatdiung WHERE ma_ho_so = $1', [rid]);
      await client.query('DELETE FROM public.tinhtrangnhiemtrung WHERE ma_ho_so = $1', [rid]);
      await client.query('DELETE FROM public.benhsucacdotbenhtruoc WHERE ma_ho_so = $1', [rid]);

      await client.query('DELETE FROM public.benhanmaydaycap WHERE ma_ho_so = $1', [rid]);
      await client.query('DELETE FROM public.benhanmaydayman WHERE ma_ho_so = $1', [rid]);
      await client.query('DELETE FROM public.hosobenhan WHERE ma_ho_so = $1', [rid]);

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    await Promise.allSettled([
      prisma.medicalRecordMeta.deleteMany({ where: { maHoSo: BigInt(rid) } }),
      prisma.medicalRecordAnswer.deleteMany({ where: { maHoSo: BigInt(rid) } }),
      prisma.answerImage.deleteMany({ where: { maHoSo: BigInt(rid) } }),
      prisma.lesionEpisodeMeta.deleteMany({ where: { maHoSo: BigInt(rid) } }),
      prisma.anhTonThuongMoRong.deleteMany({ where: { maHoSo: BigInt(rid) } }),
    ]);

    return { ma_ho_so: rid, deleted: true };
  }

  // ============================================================================
  // 3. CẬN LÂM SÀNG & ĐƠN THUỐC (medrec12, medrec13)
  // ============================================================================
  async createLabResult(user, data = {}) {
    const rid = parseInt(data.ma_ho_so || data.medical_record_id, 10);
    let sessionId = data.ma_phien_kham || data.session_id;
    let loaiBenhAn;

    if (sessionId) {
      const pkRes = await db.query(
        'SELECT ma_phien_kham, ma_ho_so, loai_benh_an FROM public.phienkham WHERE ma_phien_kham = $1 LIMIT 1',
        [sessionId]
      );
      if (!pkRes.rows[0]) throw createAppError(`Không tìm thấy phiên khám #${sessionId}`, 3007, 404);
      loaiBenhAn = pkRes.rows[0].loai_benh_an;
    } else {
      const hs = await this._getRecordOrThrow(rid, user);
      loaiBenhAn = hs.loai_benh_an;
      const sessions = await patientService.getPhienKhamList(hs.ma_ho_so);
      if (sessions.length > 0) {
        sessionId = sessions[0].ma_phien_kham;
      } else {
        const createdSession = await patientService.createPhienKham(hs.ma_ho_so, {}, user);
        sessionId = createdSession.ma_phien_kham;
      }
    }

    const client = await db.pool.connect();
    let kqRow;
    try {
      await client.query('BEGIN');

      const res = await client.query(
        `INSERT INTO public.ketquacanlamsang (
          ma_phien_kham, loai_ket_qua_can_lam_sang, wbc, crp, ige_toan_phan,
          can_lam_sang_khac_ghi_chu, xet_nghiem_khac, thoi_diem_thuc_hien
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING *`,
        [
          sessionId,
          loaiBenhAn,
          data.wbc ?? null,
          data.crp ?? null,
          data.ige_toan_phan ?? data.ige_total ?? null,
          data.can_lam_sang_khac_ghi_ro || data.notes || null,
          data.xet_nghiem_khac || null,
          data.thoi_diem_thuc_hien || new Date(),
        ]
      );
      kqRow = res.rows[0];

      // Subtype DEFERRABLE FK bắt buộc insert ketquacanlamsangcap / ketquacanlamsangman
      if (loaiBenhAn === 'CAP') {
        await client.query(
          `INSERT INTO public.ketquacanlamsangcap (ma_ket_qua_can_lam_sang, lym, neu, plt, tryptase_cap, tryptase_nen)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            kqRow.ma_ket_qua_can_lam_sang,
            data.lym ?? null,
            data.neu ?? null,
            data.plt ?? null,
            data.tryptase_cap ?? null,
            data.tryptase_nen ?? null,
          ]
        );
      } else {
        await client.query(
          `INSERT INTO public.ketquacanlamsangman (ma_ket_qua_can_lam_sang, eo, ba_bach_cau, anti_tpo, tsh, ft4, ft3)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            kqRow.ma_ket_qua_can_lam_sang,
            data.eo ?? null,
            data.ba_bach_cau ?? null,
            data.anti_tpo ?? null,
            data.tsh ?? null,
            data.ft4 ?? null,
            data.ft3 ?? null,
          ]
        );
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    return {
      ...kqRow,
      ma_ket_qua_can_lam_sang: Number(kqRow.ma_ket_qua_can_lam_sang),
      ma_phien_kham: Number(kqRow.ma_phien_kham),
    };
  }

  async getLabResultsByRecord(user, recordId) {
    const hs = await this._getRecordOrThrow(recordId, user);
    const res = await db.query(
      `SELECT k.*, pk.ma_ho_so, pk.ngay_kham, pk.lan_kham_thu,
              kc.lym, kc.neu, kc.plt, kc.nlr, kc.plr,
              km.eo, km.anti_tpo, km.tsh, km.test_huyet_thanh_tu_than
       FROM public.ketquacanlamsang k
       JOIN public.phienkham pk ON k.ma_phien_kham = pk.ma_phien_kham
       LEFT JOIN public.ketquacanlamsangcap kc ON k.ma_ket_qua_can_lam_sang = kc.ma_ket_qua_can_lam_sang
       LEFT JOIN public.ketquacanlamsangman km ON k.ma_ket_qua_can_lam_sang = km.ma_ket_qua_can_lam_sang
       WHERE pk.ma_ho_so = $1
       ORDER BY k.ma_ket_qua_can_lam_sang DESC`,
      [hs.ma_ho_so]
    );
    return res.rows.map((r) => ({
      ...r,
      ma_ket_qua_can_lam_sang: Number(r.ma_ket_qua_can_lam_sang),
      ma_phien_kham: Number(r.ma_phien_kham),
      ma_ho_so: Number(r.ma_ho_so),
    }));
  }

  async createPrescription(user, data = {}) {
    const rid = parseInt(data.ma_ho_so || data.medical_record_id, 10);
    const hs = await this._getRecordOrThrow(rid, user);
    const items = Array.isArray(data.items) ? data.items : Array.isArray(data.medicines) ? data.medicines : [];
    if (items.length === 0) {
      throw createAppError('Đơn thuốc phải có ít nhất 1 thuốc trong items[]', 2001, 400);
    }

    // Live DB public.donthuoc yêu cầu ma_phien_kham NOT NULL
    let sessionId = data.ma_phien_kham || data.session_id || null;
    if (!sessionId) {
      const sessions = await patientService.getPhienKhamList(hs.ma_ho_so);
      if (sessions.length > 0) {
        sessionId = sessions[0].ma_phien_kham;
      } else {
        const createdSession = await patientService.createPhienKham(hs.ma_ho_so, {}, user);
        sessionId = createdSession.ma_phien_kham;
      }
    }

    const client = await db.pool.connect();
    let donRow;
    const savedItems = [];
    try {
      await client.query('BEGIN');
      const dtRes = await client.query(
        `INSERT INTO public.donthuoc (
          ma_ho_so, ma_phien_kham, ngay_ke_don, trang_thai_don, ghi_chu_dieu_tri, ngung_thuoc_lan_sau, thuoc_can_ngung_truoc_tai_kham
        ) VALUES ($1, $2, COALESCE($3::DATE, CURRENT_DATE), $4, $5, $6, $7)
        RETURNING *`,
        [
          hs.ma_ho_so,
          sessionId,
          data.ngay_ke_don || null,
          ['DANG_DIEU_TRI', 'HOAN_THANH', 'HUY'].includes(data.trang_thai_don) ? data.trang_thai_don : 'DANG_DIEU_TRI',
          data.ghi_chu_dieu_tri || data.notes || null,
          Boolean(data.ngung_thuoc_lan_sau ?? false),
          data.thuoc_can_ngung_truoc_tai_kham || null,
        ]
      );
      donRow = dtRes.rows[0];

      for (const it of items) {
        let maThuoc = it.ma_thuoc || null;
        if (maThuoc) {
          const tCheck = await client.query('SELECT ma_thuoc FROM public.thuoc WHERE ma_thuoc = $1 LIMIT 1', [maThuoc]);
          if (tCheck.rows.length === 0) maThuoc = null;
        }
        const ctRes = await client.query(
          `INSERT INTO public.chitietdonthuoc (
            ma_don_thuoc, ma_thuoc, ten_thuoc_bo_sung, lieu_dung, thoi_gian_dung, ma_ke_hoach_dieu_tri
          ) VALUES ($1, $2, $3, $4, $5, $6)
          RETURNING *`,
          [
            donRow.ma_don_thuoc,
            maThuoc,
            it.ten_thuoc_bo_sung || it.ten_thuoc || it.medicine_name || null,
            it.lieu_dung || it.dosage || '1 viên/ngày',
            it.thoi_gian_dung || it.duration || '14 ngày',
            it.ma_ke_hoach_dieu_tri || null,
          ]
        );
        savedItems.push(ctRes.rows[0]);
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    return {
      ...donRow,
      ma_don_thuoc: Number(donRow.ma_don_thuoc),
      ma_ho_so: Number(donRow.ma_ho_so),
      items: savedItems.map((c) => ({
        ...c,
        ma_chi_tiet_don_thuoc: Number(c.ma_chi_tiet_don_thuoc),
        ma_don_thuoc: Number(c.ma_don_thuoc),
      })),
    };
  }

  async getPrescriptionsByRecord(user, recordId) {
    const hs = await this._getRecordOrThrow(recordId, user);
    const dtRes = await db.query(
      `SELECT * FROM public.donthuoc WHERE ma_ho_so = $1 ORDER BY ma_don_thuoc DESC`,
      [hs.ma_ho_so]
    );
    if (dtRes.rows.length === 0) return [];

    const dtIds = dtRes.rows.map((d) => d.ma_don_thuoc);
    const ctRes = await db.query(
      `SELECT ct.*, th.ten_thuoc, th.hoat_chat, th.nhom_dieu_tri
       FROM public.chitietdonthuoc ct
       LEFT JOIN public.thuoc th ON ct.ma_thuoc = th.ma_thuoc
       WHERE ct.ma_don_thuoc = ANY($1)
       ORDER BY ct.ma_chi_tiet_don_thuoc ASC`,
      [dtIds]
    );

    const itemsByDon = new Map();
    for (const c of ctRes.rows) {
      const key = Number(c.ma_don_thuoc);
      if (!itemsByDon.has(key)) itemsByDon.set(key, []);
      itemsByDon.get(key).push({
        ...c,
        ma_chi_tiet_don_thuoc: Number(c.ma_chi_tiet_don_thuoc),
        ma_don_thuoc: key,
      });
    }

    return dtRes.rows.map((d) => ({
      ...d,
      ma_don_thuoc: Number(d.ma_don_thuoc),
      ma_ho_so: Number(d.ma_ho_so),
      items: itemsByDon.get(Number(d.ma_don_thuoc)) || [],
    }));
  }

  // ============================================================================
  // 4. CHẤM ĐIỂM UAS7 & AAS HÀNG NGÀY (Slide 7)
  // ============================================================================
  async _resolveOrCreateUasCycle(client, maBenhNhan, scoreDateStr) {
    // Tìm chu kỳ 7 ngày chứa scoreDateStr (ngay_bat_dau <= scoreDateStr <= ngay_ket_thuc)
    const existingCycle = await client.query(
      `SELECT ma_chu_ky, ngay_bat_dau, ngay_ket_thuc,
              ($2::DATE - ngay_bat_dau)::INT + 1 AS day_index
       FROM public.chukytheodoiuas7
       WHERE ma_benh_nhan = $1
         AND $2::DATE BETWEEN ngay_bat_dau AND ngay_ket_thuc
       ORDER BY ngay_bat_dau DESC
       LIMIT 1`,
      [maBenhNhan, scoreDateStr]
    );
    if (existingCycle.rows[0]) {
      return existingCycle.rows[0];
    }

    // Tạo chu kỳ mới 7 ngày bắt đầu từ scoreDateStr (ck_chukyuas7_ngay: ngay_ket_thuc = ngay_bat_dau + 6)
    const createdCycle = await client.query(
      `INSERT INTO public.chukytheodoiuas7 (ma_benh_nhan, ngay_bat_dau, ngay_ket_thuc, trang_thai_chu_ky)
       VALUES ($1, $2::DATE, ($2::DATE + 6), 'DANG_THEO_DOI')
       RETURNING ma_chu_ky, ngay_bat_dau, ngay_ket_thuc, 1 AS day_index`,
      [maBenhNhan, scoreDateStr]
    );
    return createdCycle.rows[0];
  }

  async checkUas7Eligibility(user, queryParams = {}) {
    let maBenhNhan = queryParams.patient_id || queryParams.ma_benh_nhan;
    if (!isStaffRole(user) || !maBenhNhan) {
      maBenhNhan = await resolvePatientIdForUser(db, user);
    }
    if (!maBenhNhan) {
      return { eligible: false, reason: 'Tài khoản chưa liên kết hồ sơ bệnh nhân' };
    }
    maBenhNhan = await patientService.assertPatientAccess(user, maBenhNhan);
    const manRes = await db.query(
      `SELECT ma_ho_so, trang_thai FROM public.hosobenhan
       WHERE ma_benh_nhan = $1 AND loai_benh_an = 'MAN'
       ORDER BY ma_ho_so DESC LIMIT 1`,
      [maBenhNhan]
    );
    return {
      ma_benh_nhan: maBenhNhan,
      eligible: manRes.rows.length > 0,
      has_chronic_record: manRes.rows.length > 0,
      latest_chronic_record_id: manRes.rows[0] ? Number(manRes.rows[0].ma_ho_so) : null,
      reason: manRes.rows.length > 0 ? 'Đủ điều kiện chấm điểm UAS7 hàng ngày' : 'Cần có bệnh án mày đay mạn tính để theo dõi UAS7 theo chu kỳ',
    };
  }

  async logUas7Score(user, data = {}) {
    let maBenhNhan = data.ma_benh_nhan || data.patient_id;
    if (!isStaffRole(user) || !maBenhNhan) {
      maBenhNhan = await resolvePatientIdForUser(db, user);
    }
    if (!maBenhNhan) {
      throw createAppError('Không xác định được mã bệnh nhân để chấm điểm UAS7', 2001, 400);
    }
    maBenhNhan = await patientService.assertPatientAccess(user, maBenhNhan);

    const whealScore = parseInt(data.wheal_score ?? data.hss7 ?? data.hss7_score ?? data.diem_san_phu_hss, 10);
    const itchScore = parseInt(data.itch_score ?? data.iss7 ?? data.iss7_score ?? data.diem_ngua_iss, 10);
    if (
      Number.isNaN(whealScore) || whealScore < 0 || whealScore > 3 ||
      Number.isNaN(itchScore) || itchScore < 0 || itchScore > 3
    ) {
      throw createAppError('Điểm sẩn phù (wheal_score/hss7) và điểm ngứa (itch_score/iss7) phải là số nguyên 0..3', 2003, 400);
    }

    const scoreDate = String(data.score_date || data.ngay_cham_diem || new Date().toISOString().slice(0, 10)).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(scoreDate)) {
      throw createAppError('score_date phải có định dạng YYYY-MM-DD', 2003, 400);
    }

    let maHoSoMan = data.ma_ho_so_man || data.medical_record_id || null;
    if (maHoSoMan) {
      const hsCheck = await db.query(
        `SELECT ma_ho_so, loai_benh_an, ma_benh_nhan FROM public.hosobenhan WHERE ma_ho_so = $1 LIMIT 1`,
        [parseInt(maHoSoMan, 10)]
      );
      if (!hsCheck.rows[0] || hsCheck.rows[0].loai_benh_an !== 'MAN' || Number(hsCheck.rows[0].ma_benh_nhan) !== maBenhNhan) {
        maHoSoMan = null; // FK yêu cầu phải là hồ sơ MAN của chính bệnh nhân này
      }
    }

    const overwrite = Boolean(data.overwrite);
    const dupCheck = await db.query(
      'SELECT ma_nhat_ky_uas FROM public.nhatkyuashangngay WHERE ma_benh_nhan = $1 AND ngay_cham_diem = $2::DATE LIMIT 1',
      [maBenhNhan, scoreDate]
    );
    if (dupCheck.rows.length > 0 && !overwrite) {
      throw createAppError(`Ngày ${scoreDate} đã được chấm điểm UAS7 trước đó (truyền overwrite: true để cập nhật)`, 4009, 409);
    }

    const client = await db.pool.connect();
    let row;
    try {
      await client.query('BEGIN');
      if (dupCheck.rows.length > 0 && overwrite) {
        const upd = await client.query(
          `UPDATE public.nhatkyuashangngay
           SET diem_san_phu_hss = $1,
               diem_ngua_iss = $2,
               trang_thai_dung_thuoc = COALESCE($3, trang_thai_dung_thuoc)
           WHERE ma_nhat_ky_uas = $4
           RETURNING *`,
          [whealScore, itchScore, data.medication_status || data.trang_thai_dung_thuoc || null, dupCheck.rows[0].ma_nhat_ky_uas]
        );
        row = upd.rows[0];
      } else {
        const cycle = await this._resolveOrCreateUasCycle(client, maBenhNhan, scoreDate);
        const ins = await client.query(
          `INSERT INTO public.nhatkyuashangngay (
            ma_chu_ky, ma_ho_so_man, ma_benh_nhan, ngay_cham_diem, ngay_thu_may_trong_chu_ky,
            diem_san_phu_hss, diem_ngua_iss, trang_thai_dung_thuoc, trang_thai_ngay
          ) VALUES ($1, $2, $3, $4::DATE, $5, $6, $7, $8, 'HOP_LE')
          RETURNING *`,
          [
            cycle.ma_chu_ky,
            maHoSoMan,
            maBenhNhan,
            scoreDate,
            Number(cycle.day_index),
            whealScore,
            itchScore,
            data.medication_status || data.trang_thai_dung_thuoc || null,
          ]
        );
        row = ins.rows[0];
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    // Sync ghi chú sang Sub DB
    try {
      await prisma.uas7Note.upsert({
        where: { maBenhNhan_scoreDate: { maBenhNhan: BigInt(maBenhNhan), scoreDate } },
        create: {
          maBenhNhan: BigInt(maBenhNhan),
          maHoSoMan: maHoSoMan ? BigInt(maHoSoMan) : null,
          scoreDate,
          whealScore,
          itchScore,
          uasDaily: whealScore + itchScore,
          notes: data.notes || data.note || null,
          medicationChanged: Boolean(data.medication_changed ?? false),
          medicationStatus: data.medication_status || data.trang_thai_dung_thuoc || null,
        },
        update: {
          whealScore,
          itchScore,
          uasDaily: whealScore + itchScore,
          notes: data.notes !== undefined ? data.notes : undefined,
          medicationChanged: data.medication_changed !== undefined ? Boolean(data.medication_changed) : undefined,
          medicationStatus: data.medication_status || data.trang_thai_dung_thuoc || undefined,
        },
      });
    } catch (subErr) {
      console.warn('[UAS7 Note Warning]', subErr.message);
    }

    return {
      ...row,
      ma_nhat_ky_uas: Number(row.ma_nhat_ky_uas),
      ma_chu_ky: row.ma_chu_ky ? Number(row.ma_chu_ky) : null,
      ma_benh_nhan: Number(row.ma_benh_nhan),
      score_date: scoreDate,
      wheal_score: row.diem_san_phu_hss,
      itch_score: row.diem_ngua_iss,
      uas_daily: row.diem_uas_ngay,
      notes: data.notes || null,
    };
  }

  _classifyUas7Level(score) {
    if (score === 0) return 'Không còn hoạt động bệnh (0)';
    if (score <= 6) return 'Kiểm soát tốt / Rất nhẹ (1-6)';
    if (score <= 15) return 'Mức độ nhẹ (7-15)';
    if (score <= 27) return 'Mức độ trung bình (16-27)';
    return 'Mức độ nặng (28-42)';
  }

  async getUas7Scores(user, queryParams = {}) {
    let maBenhNhan = queryParams.patient_id || queryParams.ma_benh_nhan;
    if (!isStaffRole(user) || !maBenhNhan) {
      maBenhNhan = await resolvePatientIdForUser(db, user);
    }
    if (!maBenhNhan) {
      throw createAppError('Thiếu mã bệnh nhân', 2001, 400);
    }
    maBenhNhan = await patientService.assertPatientAccess(user, maBenhNhan);

    const params = [maBenhNhan];
    let dateFilter = '';
    if (queryParams.from) {
      params.push(queryParams.from);
      dateFilter += ` AND n.ngay_cham_diem >= $${params.length}::DATE`;
    }
    if (queryParams.to) {
      params.push(queryParams.to);
      dateFilter += ` AND n.ngay_cham_diem <= $${params.length}::DATE`;
    }

    const [logsRes, cyclesRes, notes] = await Promise.all([
      db.query(
        `SELECT n.* FROM public.nhatkyuashangngay n
         WHERE n.ma_benh_nhan = $1 ${dateFilter}
         ORDER BY n.ngay_cham_diem DESC
         LIMIT 90`,
        params
      ),
      db.query(
        `SELECT * FROM public.v_chukytheodoiuas7
         WHERE ma_benh_nhan = $1
         ORDER BY ngay_bat_dau DESC
         LIMIT 12`,
        [maBenhNhan]
      ),
      prisma.uas7Note.findMany({ where: { maBenhNhan: BigInt(maBenhNhan) } }).catch(() => []),
    ]);

    const noteMap = new Map(notes.map((n) => [n.scoreDate, n]));
    const items = logsRes.rows.map((r) => {
      const dateStr = r.ngay_cham_diem instanceof Date ? r.ngay_cham_diem.toISOString().slice(0, 10) : String(r.ngay_cham_diem).slice(0, 10);
      const sub = noteMap.get(dateStr);
      return {
        ...r,
        ma_nhat_ky_uas: Number(r.ma_nhat_ky_uas),
        ma_chu_ky: r.ma_chu_ky ? Number(r.ma_chu_ky) : null,
        ma_benh_nhan: Number(r.ma_benh_nhan),
        score_date: dateStr,
        wheal_score: r.diem_san_phu_hss,
        itch_score: r.diem_ngua_iss,
        uas_daily: r.diem_uas_ngay,
        notes: sub?.notes || null,
        medication_changed: sub?.medicationChanged || false,
      };
    });

    const last7 = items.slice(0, 7);
    const uas7Score = last7.reduce((sum, x) => sum + (Number(x.uas_daily) || 0), 0);

    return {
      ma_benh_nhan: maBenhNhan,
      summary: {
        days_logged: items.length,
        latest_7_days_count: last7.length,
        uas7_score: uas7Score,
        severity_level: this._classifyUas7Level(uas7Score),
      },
      cycles: cyclesRes.rows.map((c) => ({
        ...c,
        ma_chu_ky: Number(c.ma_chu_ky),
        ma_benh_nhan: Number(c.ma_benh_nhan),
      })),
      items,
    };
  }

  async logAasScore(user, data = {}) {
    let maBenhNhan = data.ma_benh_nhan || data.patient_id;
    if (!isStaffRole(user) || !maBenhNhan) {
      maBenhNhan = await resolvePatientIdForUser(db, user);
    }
    maBenhNhan = await patientService.assertPatientAccess(user, maBenhNhan);

    const scoreDate = String(data.score_date || data.ngay_theo_doi || new Date().toISOString().slice(0, 10)).slice(0, 10);
    const hasAngioedema = Boolean(data.co_dot_sung_phu ?? data.has_angioedema ?? false);

    let maHoSoMan = data.ma_ho_so_man || data.medical_record_id || null;
    if (maHoSoMan) {
      const chk = await db.query(
        'SELECT ma_ho_so FROM public.benhanmaydayman WHERE ma_ho_so = $1 LIMIT 1',
        [parseInt(maHoSoMan, 10)]
      );
      if (chk.rows.length === 0) maHoSoMan = null;
    }

    const clamp03 = (v) => (v === undefined || v === null ? null : Math.min(3, Math.max(0, parseInt(v, 10) || 0)));

    const res = await db.query(
      `INSERT INTO public.nhatkyaashangngay (
        ma_benh_nhan, ma_ho_so_man, ngay_theo_doi, co_dot_sung_phu, thoi_diem_xuat_hien,
        muc_kho_chiu, han_che_hoat_dong, anh_huong_ngoai_hinh, do_nang_tong_the
      ) VALUES ($1, $2, $3::DATE, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (ma_benh_nhan, ngay_theo_doi)
      DO UPDATE SET
        co_dot_sung_phu = EXCLUDED.co_dot_sung_phu,
        thoi_diem_xuat_hien = EXCLUDED.thoi_diem_xuat_hien,
        muc_kho_chiu = EXCLUDED.muc_kho_chiu,
        han_che_hoat_dong = EXCLUDED.han_che_hoat_dong,
        anh_huong_ngoai_hinh = EXCLUDED.anh_huong_ngoai_hinh,
        do_nang_tong_the = EXCLUDED.do_nang_tong_the
      RETURNING *`,
      [
        maBenhNhan,
        maHoSoMan,
        scoreDate,
        hasAngioedema,
        data.thoi_diem_xuat_hien || null,
        hasAngioedema ? clamp03(data.muc_kho_chiu ?? 0) : null,
        hasAngioedema ? clamp03(data.han_che_hoat_dong ?? 0) : null,
        hasAngioedema ? clamp03(data.anh_huong_ngoai_hinh ?? 0) : null,
        hasAngioedema ? clamp03(data.do_nang_tong_the ?? 0) : null,
      ]
    );
    const r = res.rows[0];
    return {
      ...r,
      ma_nhat_ky_aas: Number(r.ma_nhat_ky_aas),
      ma_benh_nhan: Number(r.ma_benh_nhan),
    };
  }

  async getAasScores(user, queryParams = {}) {
    let maBenhNhan = queryParams.patient_id || queryParams.ma_benh_nhan;
    if (!isStaffRole(user) || !maBenhNhan) {
      maBenhNhan = await resolvePatientIdForUser(db, user);
    }
    maBenhNhan = await patientService.assertPatientAccess(user, maBenhNhan);

    const res = await db.query(
      'SELECT * FROM public.nhatkyaashangngay WHERE ma_benh_nhan = $1 ORDER BY ngay_theo_doi DESC LIMIT 90',
      [maBenhNhan]
    );
    const items = res.rows.map((r) => ({
      ...r,
      ma_nhat_ky_aas: Number(r.ma_nhat_ky_aas),
      ma_benh_nhan: Number(r.ma_benh_nhan),
    }));
    const aas7 = items.slice(0, 7).reduce((s, i) => s + (Number(i.diem_aas_ngay) || 0), 0);
    const aas28 = items.slice(0, 28).reduce((s, i) => s + (Number(i.diem_aas_ngay) || 0), 0);
    return { ma_benh_nhan: maBenhNhan, summary: { aas7_score: aas7, aas28_score: aas28 }, items };
  }

  // ============================================================================
  // 5. ĐỢT TỔN THƯƠNG, VỊ TRÍ, ẢNH & SUPABASE STORAGE (Slide 8 & 9)
  // ============================================================================
  _normalizeCircumstance(hoanCanh, hoanCanhKhac) {
    if (!hoanCanh) return { hoanCanh: null, hoanCanhKhac: null };
    const clean = String(hoanCanh).trim();
    if (clean === 'Khac' || clean.toLowerCase() === 'khác' || clean.toLowerCase() === 'other') {
      const detail = String(hoanCanhKhac || 'Yếu tố khác').trim();
      return { hoanCanh: 'Khac', hoanCanhKhac: detail };
    }
    // Theo ck_dottonthuongda_hoancanh / ck_vitritonthuong_hoancanh: khác 'Khac' thì khac PHẢI là NULL!
    return { hoanCanh: clean, hoanCanhKhac: null };
  }

  async createLesionEpisode(user, data = {}) {
    const rid = parseInt(data.ma_ho_so || data.medical_record_id, 10);
    const hs = await this._getRecordOrThrow(rid, user);

    // Chỉ gán ma_ho_so_man nếu hồ sơ là MAN (FK tới benhanmaydayman), còn CAP để NULL & lưu ở Sub DB
    const maHoSoMan = hs.loai_benh_an === 'MAN' ? Number(hs.ma_ho_so) : null;
    const rawCtx = data.hoan_canh_xuat_hien || data.trigger_category;
    const ctxTagOther = !rawCtx && data.context_tags ? 'Khac' : rawCtx;
    const ctxOtherDetail =
      data.hoan_canh_xuat_hien_khac ||
      (!rawCtx && data.context_tags ? String(data.context_tags) : null);
    const { hoanCanh, hoanCanhKhac } = this._normalizeCircumstance(ctxTagOther, ctxOtherDetail);

    const res = await db.query(
      `INSERT INTO public.dottonthuongda (
        ma_benh_nhan, ma_ho_so_man, ten_dot_ton_thuong_da, thoi_diem_xuat_hien,
        hoan_canh_xuat_hien, hoan_canh_xuat_hien_khac, ten_thuoc_dung_gan_thoi_diem_xuat_hien,
        thoi_gian_dung_thuoc_truoc_khi_xuat_hien, don_vi_thoi_gian, chi_tiet_dot_ton_thuong
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *`,
      [
        hs.ma_benh_nhan,
        maHoSoMan,
        data.ten_dot_ton_thuong_da || data.episode_name || data.name || 'Đợt bùng phát mới',
        data.thoi_diem_xuat_hien || data.started_at || data.occurred_at || new Date(),
        hoanCanh,
        hoanCanhKhac,
        data.ten_thuoc_dung_gan_thoi_diem_xuat_hien || data.medication_name || null,
        data.thoi_gian_dung_thuoc_truoc_khi_xuat_hien || null,
        data.don_vi_thoi_gian || null,
        data.chi_tiet_dot_ton_thuong || data.notes || data.description || null,
      ]
    );
    const row = res.rows[0];

    await prisma.lesionEpisodeMeta.upsert({
      where: { maDotTonThuong: BigInt(row.ma_dot_ton_thuong_da) },
      create: {
        maDotTonThuong: BigInt(row.ma_dot_ton_thuong_da),
        maHoSo: BigInt(hs.ma_ho_so),
        maBenhNhan: BigInt(hs.ma_benh_nhan),
        hasLesions: data.has_lesions !== undefined ? Boolean(data.has_lesions) : true,
        triggerCategory: hoanCanh,
      },
      update: {
        hasLesions: data.has_lesions !== undefined ? Boolean(data.has_lesions) : true,
        triggerCategory: hoanCanh,
      },
    }).catch(() => null);

    return {
      ...row,
      ma_dot_ton_thuong_da: Number(row.ma_dot_ton_thuong_da),
      ma_benh_nhan: Number(row.ma_benh_nhan),
      ma_ho_so: Number(hs.ma_ho_so),
      id: Number(row.ma_dot_ton_thuong_da),
    };
  }

  async getLesionEpisodes(user, queryParams = {}) {
    const recordId = queryParams.medical_record_id || queryParams.ma_ho_so;
    let patientId = queryParams.patient_id || queryParams.ma_benh_nhan;

    if (recordId) {
      const hs = await this._getRecordOrThrow(recordId, user);
      patientId = Number(hs.ma_benh_nhan);
    } else if (!isStaffRole(user) || !patientId) {
      patientId = await resolvePatientIdForUser(db, user);
    }
    if (!patientId) return [];
    patientId = await patientService.assertPatientAccess(user, patientId);

    const rowsRes = await db.query(
      `SELECT * FROM public.dottonthuongda WHERE ma_benh_nhan = $1 ORDER BY ma_dot_ton_thuong_da DESC`,
      [patientId]
    );

    const metas = await prisma.lesionEpisodeMeta
      .findMany({ where: { maBenhNhan: BigInt(patientId) } })
      .catch(() => []);
    const metaMap = new Map(metas.map((m) => [Number(m.maDotTonThuong), m]));

    let result = rowsRes.rows.map((r) => {
      const m = metaMap.get(Number(r.ma_dot_ton_thuong_da));
      return {
        ...r,
        ma_dot_ton_thuong_da: Number(r.ma_dot_ton_thuong_da),
        ma_benh_nhan: Number(r.ma_benh_nhan),
        ma_ho_so_man: r.ma_ho_so_man ? Number(r.ma_ho_so_man) : null,
        ma_ho_so: m ? Number(m.maHoSo) : r.ma_ho_so_man ? Number(r.ma_ho_so_man) : null,
        id: Number(r.ma_dot_ton_thuong_da),
        has_lesions: m ? m.hasLesions : true,
      };
    });

    if (recordId) {
      const rid = parseInt(recordId, 10);
      result = result.filter((e) => e.ma_ho_so === rid || e.ma_ho_so_man === rid);
    }
    return result;
  }

  async updateLesionEpisode(user, episodeId, data = {}) {
    const eid = parseInt(episodeId, 10);
    const chk = await db.query('SELECT * FROM public.dottonthuongda WHERE ma_dot_ton_thuong_da = $1 LIMIT 1', [eid]);
    const existing = chk.rows[0];
    if (!existing) throw createAppError(`Không tìm thấy đợt tổn thương #${eid}`, 3007, 404);
    await patientService.assertPatientAccess(user, existing.ma_benh_nhan);

    const sets = [];
    const vals = [];
    let idx = 1;
    if (data.ten_dot_ton_thuong_da !== undefined || data.episode_name !== undefined || data.name !== undefined) {
      sets.push(`ten_dot_ton_thuong_da = $${idx++}`);
      vals.push(data.ten_dot_ton_thuong_da ?? data.episode_name ?? data.name);
    }
    if (data.chi_tiet_dot_ton_thuong !== undefined || data.notes !== undefined || data.description !== undefined) {
      sets.push(`chi_tiet_dot_ton_thuong = $${idx++}`);
      vals.push(data.chi_tiet_dot_ton_thuong ?? data.notes ?? data.description);
    }
    if (data.hoan_canh_xuat_hien !== undefined) {
      const { hoanCanh, hoanCanhKhac } = this._normalizeCircumstance(data.hoan_canh_xuat_hien, data.hoan_canh_xuat_hien_khac);
      sets.push(`hoan_canh_xuat_hien = $${idx++}`);
      vals.push(hoanCanh);
      sets.push(`hoan_canh_xuat_hien_khac = $${idx++}`);
      vals.push(hoanCanhKhac);
    }

    let updated = existing;
    if (sets.length > 0) {
      vals.push(eid);
      const uRes = await db.query(
        `UPDATE public.dottonthuongda SET ${sets.join(', ')} WHERE ma_dot_ton_thuong_da = $${idx} RETURNING *`,
        vals
      );
      updated = uRes.rows[0];
    }

    if (data.ended_at !== undefined || data.has_lesions !== undefined) {
      await prisma.lesionEpisodeMeta.updateMany({
        where: { maDotTonThuong: BigInt(eid) },
        data: {
          endedAt: data.ended_at ? new Date(data.ended_at) : undefined,
          hasLesions: data.has_lesions !== undefined ? Boolean(data.has_lesions) : undefined,
        },
      }).catch(() => null);
    }

    return {
      ...updated,
      ma_dot_ton_thuong_da: Number(updated.ma_dot_ton_thuong_da),
      ma_benh_nhan: Number(updated.ma_benh_nhan),
      id: Number(updated.ma_dot_ton_thuong_da),
    };
  }

  async getLesionEpisodeById(user, episodeId) {
    const eid = parseInt(episodeId, 10);
    const res = await db.query('SELECT * FROM public.dottonthuongda WHERE ma_dot_ton_thuong_da = $1 LIMIT 1', [eid]);
    const row = res.rows[0];
    if (!row) throw createAppError(`Không tìm thấy đợt tổn thương #${eid}`, 3007, 404);
    await patientService.assertPatientAccess(user, row.ma_benh_nhan);
    const locations = await this.getLesionLocations(user, { episode_id: eid });
    return {
      ...row,
      ma_dot_ton_thuong_da: Number(row.ma_dot_ton_thuong_da),
      ma_benh_nhan: Number(row.ma_benh_nhan),
      id: Number(row.ma_dot_ton_thuong_da),
      locations,
    };
  }

  async deleteLesionEpisode(user, episodeId) {
    const eid = parseInt(episodeId, 10);
    const res = await db.query('SELECT ma_benh_nhan FROM public.dottonthuongda WHERE ma_dot_ton_thuong_da = $1 LIMIT 1', [eid]);
    if (!res.rows[0]) throw createAppError(`Không tìm thấy đợt tổn thương #${eid}`, 3007, 404);
    await patientService.assertPatientAccess(user, res.rows[0].ma_benh_nhan);

    await db.query('DELETE FROM public.anhchuptonthuong WHERE ma_dot_ton_thuong_da = $1', [eid]);
    await db.query('DELETE FROM public.vitritonthuong WHERE ma_dot_ton_thuong_da = $1', [eid]);
    await db.query('DELETE FROM public.dottonthuongda WHERE ma_dot_ton_thuong_da = $1', [eid]);
    await prisma.lesionEpisodeMeta.deleteMany({ where: { maDotTonThuong: BigInt(eid) } }).catch(() => null);
    return { ma_dot_ton_thuong_da: eid, deleted: true };
  }

  async createLesionLocation(user, data = {}) {
    const eid = parseInt(data.episode_id || data.ma_dot_ton_thuong_da, 10);
    const epRes = await db.query('SELECT * FROM public.dottonthuongda WHERE ma_dot_ton_thuong_da = $1 LIMIT 1', [eid]);
    const ep = epRes.rows[0];
    if (!ep) throw createAppError(`Không tìm thấy đợt tổn thương #${eid}`, 3007, 404);
    await patientService.assertPatientAccess(user, ep.ma_benh_nhan);

    const bodyPart = String(data.vi_tri_co_the || data.body_part || '').trim();
    if (!bodyPart) {
      throw createAppError('Thiếu vị trí cơ thể (vi_tri_co_the / body_part)', 2001, 400);
    }
    const { hoanCanh, hoanCanhKhac } = this._normalizeCircumstance(data.hoan_canh_xuat_hien, data.hoan_canh_xuat_hien_khac);

    const ins = await db.query(
      `INSERT INTO public.vitritonthuong (
        ma_dot_ton_thuong_da, vi_tri_co_the, thoi_diem_xuat_hien, ten_thuoc_lien_quan,
        thoi_gian_dung_thuoc_truoc_khi_xuat_hien, hoan_canh_xuat_hien, hoan_canh_xuat_hien_khac, don_vi_thoi_gian
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *`,
      [
        eid,
        bodyPart,
        data.thoi_diem_xuat_hien || data.occurred_at || new Date(),
        data.ten_thuoc_lien_quan || null,
        data.thoi_gian_dung_thuoc_truoc_khi_xuat_hien || null,
        hoanCanh,
        hoanCanhKhac,
        data.don_vi_thoi_gian || null,
      ]
    );
    const row = ins.rows[0];

    await prisma.lesionLocationMeta.upsert({
      where: { maViTriTonThuong: BigInt(row.ma_vi_tri_ton_thuong) },
      create: {
        maViTriTonThuong: BigInt(row.ma_vi_tri_ton_thuong),
        maDotTonThuong: BigInt(eid),
        bodyPart,
        lesionType: data.lesion_type || null,
        itchScoreNrs: data.itch_score_nrs !== undefined ? parseInt(data.itch_score_nrs, 10) : null,
        painScoreNrs: data.pain_score_nrs !== undefined ? parseInt(data.pain_score_nrs, 10) : null,
        notes: data.notes || null,
      },
      update: { bodyPart },
    }).catch(() => null);

    return {
      ...row,
      ma_vi_tri_ton_thuong: Number(row.ma_vi_tri_ton_thuong),
      ma_dot_ton_thuong_da: Number(row.ma_dot_ton_thuong_da),
      id: Number(row.ma_vi_tri_ton_thuong),
      body_part: bodyPart,
    };
  }

  async getLesionLocations(user, queryParams = {}) {
    const eid = queryParams.episode_id || queryParams.ma_dot_ton_thuong_da;
    if (eid) {
      const epRes = await db.query('SELECT ma_benh_nhan FROM public.dottonthuongda WHERE ma_dot_ton_thuong_da = $1 LIMIT 1', [parseInt(eid, 10)]);
      if (!epRes.rows[0]) return [];
      await patientService.assertPatientAccess(user, epRes.rows[0].ma_benh_nhan);

      const res = await db.query(
        'SELECT * FROM public.vitritonthuong WHERE ma_dot_ton_thuong_da = $1 ORDER BY ma_vi_tri_ton_thuong DESC',
        [parseInt(eid, 10)]
      );
      return res.rows.map((r) => ({
        ...r,
        ma_vi_tri_ton_thuong: Number(r.ma_vi_tri_ton_thuong),
        ma_dot_ton_thuong_da: Number(r.ma_dot_ton_thuong_da),
        id: Number(r.ma_vi_tri_ton_thuong),
      }));
    }

    const params = [];
    let where = '';
    if (!isStaffRole(user)) {
      const pid = await resolvePatientIdForUser(db, user);
      if (!pid) return [];
      params.push(pid);
      where = 'WHERE d.ma_benh_nhan = $1';
    }
    const res = await db.query(
      `SELECT v.* FROM public.vitritonthuong v
       JOIN public.dottonthuongda d ON v.ma_dot_ton_thuong_da = d.ma_dot_ton_thuong_da
       ${where}
       ORDER BY v.ma_vi_tri_ton_thuong DESC
       LIMIT 100`,
      params
    );
    return res.rows.map((r) => ({
      ...r,
      ma_vi_tri_ton_thuong: Number(r.ma_vi_tri_ton_thuong),
      ma_dot_ton_thuong_da: Number(r.ma_dot_ton_thuong_da),
      id: Number(r.ma_vi_tri_ton_thuong),
    }));
  }

  async updateLesionLocation(user, locationId, data = {}) {
    const lid = parseInt(locationId, 10);
    const res = await db.query(
      `SELECT v.*, d.ma_benh_nhan
       FROM public.vitritonthuong v
       JOIN public.dottonthuongda d ON v.ma_dot_ton_thuong_da = d.ma_dot_ton_thuong_da
       WHERE v.ma_vi_tri_ton_thuong = $1 LIMIT 1`,
      [lid]
    );
    if (!res.rows[0]) throw createAppError(`Không tìm thấy vị trí tổn thương #${lid}`, 3007, 404);
    await patientService.assertPatientAccess(user, res.rows[0].ma_benh_nhan);

    const bodyPart = data.vi_tri_co_the !== undefined ? data.vi_tri_co_the : data.body_part;
    const upd = await db.query(
      `UPDATE public.vitritonthuong
       SET vi_tri_co_the = COALESCE($1, vi_tri_co_the),
           ten_thuoc_lien_quan = COALESCE($2, ten_thuoc_lien_quan)
       WHERE ma_vi_tri_ton_thuong = $3
       RETURNING *`,
      [bodyPart || null, data.ten_thuoc_lien_quan || null, lid]
    );
    const subUpdate = {};
    if (bodyPart) subUpdate.bodyPart = bodyPart;
    if (data.notes !== undefined) subUpdate.notes = data.notes;
    if (Object.keys(subUpdate).length > 0) {
      await prisma.lesionLocationMeta.updateMany({ where: { maViTriTonThuong: BigInt(lid) }, data: subUpdate }).catch(() => null);
    }
    const meta = await prisma.lesionLocationMeta.findUnique({ where: { maViTriTonThuong: BigInt(lid) } }).catch(() => null);
    return {
      ...upd.rows[0],
      ma_vi_tri_ton_thuong: Number(upd.rows[0].ma_vi_tri_ton_thuong),
      id: Number(upd.rows[0].ma_vi_tri_ton_thuong),
      notes: meta?.notes ?? null,
    };
  }

  async deleteLesionLocation(user, locationId) {
    const lid = parseInt(locationId, 10);
    const res = await db.query(
      `SELECT v.*, d.ma_benh_nhan
       FROM public.vitritonthuong v
       JOIN public.dottonthuongda d ON v.ma_dot_ton_thuong_da = d.ma_dot_ton_thuong_da
       WHERE v.ma_vi_tri_ton_thuong = $1 LIMIT 1`,
      [lid]
    );
    if (!res.rows[0]) throw createAppError(`Không tìm thấy vị trí tổn thương #${lid}`, 3007, 404);
    await patientService.assertPatientAccess(user, res.rows[0].ma_benh_nhan);

    await db.query('DELETE FROM public.anhchuptonthuong WHERE ma_vi_tri_ton_thuong = $1', [lid]);
    await db.query('DELETE FROM public.vitritonthuong WHERE ma_vi_tri_ton_thuong = $1', [lid]);
    await prisma.lesionLocationMeta.deleteMany({ where: { maViTriTonThuong: BigInt(lid) } }).catch(() => null);
    return { ma_vi_tri_ton_thuong: lid, deleted: true };
  }

  /**
   * Upload file ảnh thật lên Supabase Storage bucket (mayday-attachments)
   * và ghi đối chiếu vào tepdinhkem (Main DB) + anh_ton_thuong_mo_rong (Sub DB)
   */
  async uploadAttachmentToSupabase(user, file, body = {}) {
    if (!file || !file.buffer) {
      throw createAppError('Thiếu tệp tải lên (field: file)', 2001, 400);
    }
    if (!isConfigured || !supabase) {
      throw createAppError('Supabase Storage chưa được cấu hình', 5001, 500);
    }

    const maHoSoRaw = body.medical_record_id || body.ma_ho_so;
    let maHoSo = 0;
    if (maHoSoRaw) {
      const hs = await this._getRecordOrThrow(maHoSoRaw, user);
      maHoSo = Number(hs.ma_ho_so);
    }

    const ext = path.extname(file.originalname || '').toLowerCase() || '.jpg';
    const randomName = `${Date.now()}_${crypto.randomBytes(6).toString('hex')}${ext}`;
    const folder = maHoSo > 0 ? `records/${maHoSo}` : `users/${user.ma_tai_khoan}`;
    const storagePath = `${folder}/${randomName}`;

    const { error: uploadErr } = await supabase.storage
      .from(bucketName)
      .upload(storagePath, file.buffer, {
        contentType: file.mimetype || 'image/jpeg',
        upsert: false,
      });

    if (uploadErr) {
      throw createAppError(`Lỗi upload lên Supabase Storage: ${uploadErr.message}`, 5002, 502);
    }

    const { data: pubData } = supabase.storage.from(bucketName).getPublicUrl(storagePath);
    const publicUrl = pubData?.publicUrl || '';

    let maTepDinhKem = null;
    if (maHoSo > 0) {
      const tepRes = await db.query(
        `INSERT INTO public.tepdinhkem (
          ma_ho_so, ma_tai_khoan, ten_tep_goc, duong_dan_luu_tru, duong_dan_url,
          dinh_dang_tep, loai_phuong_tien, dung_luong_byte, phan_loai_muc_dich, mo_ta_tep
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING *`,
        [
          maHoSo,
          user.ma_tai_khoan,
          file.originalname || randomName,
          storagePath,
          publicUrl,
          file.mimetype || 'image/jpeg',
          file.mimetype && file.mimetype.startsWith('image/') ? 'IMAGE' : 'DOCUMENT',
          file.size || file.buffer.length,
          body.purpose || body.phan_loai_muc_dich || 'LESION_PHOTO',
          body.description || body.mo_ta_tep || null,
        ]
      );
      maTepDinhKem = Number(tepRes.rows[0].ma_tep_dinh_kem);
    }

    const anhSub = await prisma.anhTonThuongMoRong.create({
      data: {
        maHoSo: BigInt(maHoSo),
        maTaiKhoan: BigInt(user.ma_tai_khoan),
        maTepDinhKemGoc: maTepDinhKem ? BigInt(maTepDinhKem) : null,
        bucketName,
        storagePath,
        publicUrl,
        dinhDangTep: file.mimetype || 'image/jpeg',
        dungLuongBytes: BigInt(file.size || file.buffer.length),
        toaDoX: body.toa_do_x !== undefined ? parseFloat(body.toa_do_x) : null,
        toaDoY: body.toa_do_y !== undefined ? parseFloat(body.toa_do_y) : null,
        vungCoThe: body.vung_co_the || body.body_part || null,
        ghiChuLamSang: body.ghi_chu_lam_sang || body.notes || null,
        diemNguaNrs: body.diem_ngua_nrs !== undefined ? parseInt(body.diem_ngua_nrs, 10) : null,
        diemDauNrs: body.diem_dau_nrs !== undefined ? parseInt(body.diem_dau_nrs, 10) : null,
      },
    });

    return {
      id: maTepDinhKem || anhSub.id,
      ma_tep_dinh_kem: maTepDinhKem,
      sub_id: anhSub.id,
      ma_ho_so: maHoSo || null,
      bucket_name: bucketName,
      storage_path: storagePath,
      public_url: publicUrl,
      url: publicUrl,
      mime_type: file.mimetype,
      size_bytes: file.size || file.buffer.length,
    };
  }

  async listAttachments(user, queryParams = {}) {
    const rid = queryParams.medical_record_id || queryParams.ma_ho_so;
    const uid = queryParams.user_id || queryParams.ma_tai_khoan;
    if (rid) {
      const hs = await this._getRecordOrThrow(rid, user);
      const rows = await prisma.anhTonThuongMoRong.findMany({
        where: { maHoSo: BigInt(hs.ma_ho_so) },
        orderBy: { thoiDiemTao: 'desc' },
      });
      return rows;
    }
    if (uid) {
      const parsedUid = parseInt(uid, 10);
      if (Number.isNaN(parsedUid)) throw createAppError('user_id không hợp lệ', 2003, 400);
      const selfPid = await resolvePatientIdForUser(db, user);
      const isSelf =
        parsedUid === Number(user.ma_tai_khoan) ||
        (user.ma_nguoi && parsedUid === Number(user.ma_nguoi)) ||
        (selfPid && parsedUid === Number(selfPid));
      if (!isStaffRole(user) && !isSelf) {
        throw createAppError('Không có quyền xem tệp đính kèm của người dùng khác', 3106, 403);
      }
      const tkRes = await db.query(
        'SELECT ma_tai_khoan FROM public.taikhoan WHERE ma_tai_khoan = $1 OR ma_nguoi = $1',
        [parsedUid]
      );
      const tkIds = tkRes.rows.length > 0 ? tkRes.rows.map((r) => BigInt(r.ma_tai_khoan)) : [BigInt(parsedUid)];
      return prisma.anhTonThuongMoRong.findMany({
        where: { maTaiKhoan: { in: tkIds } },
        orderBy: { thoiDiemTao: 'desc' },
        take: 100,
      });
    }
    return prisma.anhTonThuongMoRong.findMany({
      where: isStaffRole(user) ? {} : { maTaiKhoan: BigInt(user.ma_tai_khoan) },
      orderBy: { thoiDiemTao: 'desc' },
      take: 100,
    });
  }

  async deleteAttachment(user, attachmentId) {
    const id = parseInt(attachmentId, 10);
    // Tìm theo maTepDinhKemGoc hoặc Sub ID
    let sub = await prisma.anhTonThuongMoRong.findFirst({
      where: {
        OR: [{ maTepDinhKemGoc: BigInt(id) }, { id }],
      },
    });
    if (!sub) {
      const tepRes = await db.query('SELECT * FROM public.tepdinhkem WHERE ma_tep_dinh_kem = $1 LIMIT 1', [id]);
      if (!tepRes.rows[0]) throw createAppError(`Không tìm thấy tệp đính kèm #${id}`, 3007, 404);
      const t = tepRes.rows[0];
      if (!isStaffRole(user) && Number(t.ma_tai_khoan) !== Number(user.ma_tai_khoan)) {
        throw createAppError('Không có quyền xóa tệp đính kèm của người khác', 3106, 403);
      }
      if (isConfigured && supabase && t.duong_dan_luu_tru) {
        await supabase.storage.from(bucketName).remove([t.duong_dan_luu_tru]).catch(() => null);
      }
      await db.query('DELETE FROM public.anhchuptonthuong WHERE ma_tep_dinh_kem = $1', [id]);
      await db.query('DELETE FROM public.tepdinhkem WHERE ma_tep_dinh_kem = $1', [id]);
      return { id, deleted: true };
    }

    if (!isStaffRole(user) && Number(sub.maTaiKhoan) !== Number(user.ma_tai_khoan)) {
      throw createAppError('Không có quyền xóa tệp đính kèm của người khác', 3106, 403);
    }

    if (isConfigured && supabase && sub.storagePath) {
      await supabase.storage.from(sub.bucketName || bucketName).remove([sub.storagePath]).catch(() => null);
    }

    if (sub.maTepDinhKemGoc) {
      const tepId = Number(sub.maTepDinhKemGoc);
      await db.query('DELETE FROM public.anhchuptonthuong WHERE ma_tep_dinh_kem = $1', [tepId]).catch(() => null);
      await db.query('DELETE FROM public.tepdinhkem WHERE ma_tep_dinh_kem = $1', [tepId]).catch(() => null);
    }
    await prisma.anhTonThuongMoRong.delete({ where: { id: sub.id } });
    return { id, deleted: true };
  }

  async createLesionPhoto(user, data = {}) {
    let episodeId = data.episode_id || data.ma_dot_ton_thuong_da || null;
    const locationId = data.location_id || data.ma_vi_tri_ton_thuong || null;
    let maTepDinhKem = data.attachment_id || data.ma_tep_dinh_kem || null;
    let maHoSo = data.medical_record_id || data.ma_ho_so || null;

    if (locationId && !episodeId) {
      const locRes = await db.query('SELECT ma_dot_ton_thuong_da FROM public.vitritonthuong WHERE ma_vi_tri_ton_thuong = $1 LIMIT 1', [parseInt(locationId, 10)]);
      if (locRes.rows[0]) episodeId = Number(locRes.rows[0].ma_dot_ton_thuong_da);
    }

    if (episodeId) {
      const epRes = await db.query('SELECT ma_benh_nhan, ma_ho_so_man FROM public.dottonthuongda WHERE ma_dot_ton_thuong_da = $1 LIMIT 1', [parseInt(episodeId, 10)]);
      if (!epRes.rows[0]) throw createAppError(`Không tìm thấy đợt tổn thương #${episodeId}`, 3007, 404);
      await patientService.assertPatientAccess(user, epRes.rows[0].ma_benh_nhan);
      if (!maHoSo && epRes.rows[0].ma_ho_so_man) maHoSo = Number(epRes.rows[0].ma_ho_so_man);
    }

    // Nếu chưa có ma_tep_dinh_kem (FK NOT NULL trong anhchuptonthuong) nhưng có url + maHoSo, tự tạo tepdinhkem
    if (!maTepDinhKem && maHoSo && (data.url || data.public_url || data.image_url || data.storage_path)) {
      const urlVal = data.public_url || data.url || data.image_url || '';
      const storagePath = data.storage_path || urlVal;
      const tepIns = await db.query(
        `INSERT INTO public.tepdinhkem (ma_ho_so, ma_tai_khoan, ten_tep_goc, duong_dan_luu_tru, duong_dan_url, dinh_dang_tep, dung_luong_byte)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ma_tep_dinh_kem`,
        [maHoSo, user.ma_tai_khoan, data.file_name || 'lesion.jpg', storagePath, urlVal, 'image/jpeg', 1024]
      );
      maTepDinhKem = Number(tepIns.rows[0].ma_tep_dinh_kem);
    }

    if (!maTepDinhKem) {
      throw createAppError('Cần cung cấp attachment_id (ma_tep_dinh_kem) từ bước upload ảnh', 2001, 400);
    }

    const tepRes = await db.query('SELECT duong_dan_url FROM public.tepdinhkem WHERE ma_tep_dinh_kem = $1 LIMIT 1', [maTepDinhKem]);
    if (!tepRes.rows[0]) {
      throw createAppError(`Không tìm thấy tệp đính kèm #${maTepDinhKem}`, 3007, 404);
    }

    const clamp010 = (v) => (v === undefined || v === null ? null : Math.min(10, Math.max(0, parseInt(v, 10) || 0)));

    const res = await db.query(
      `INSERT INTO public.anhchuptonthuong (
        ma_tep_dinh_kem, ma_dot_ton_thuong_da, ma_vi_tri_ton_thuong, thoi_diem_chup,
        moc_tien_trien, diem_ngua_nrs, diem_dau_nrs, diem_bong_rat_nrs, so_luong_not_san, url_anh
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *`,
      [
        maTepDinhKem,
        episodeId ? parseInt(episodeId, 10) : null,
        locationId ? parseInt(locationId, 10) : null,
        data.thoi_diem_chup || data.captured_at || new Date(),
        data.moc_tien_trien || data.milestone || null,
        clamp010(data.diem_ngua_nrs ?? data.itch_score_nrs ?? data.itch_score),
        clamp010(data.diem_dau_nrs ?? data.pain_score_nrs ?? data.pain_score),
        clamp010(data.diem_bong_rat_nrs ?? data.burning_score_nrs ?? data.burn_score),
        (data.so_luong_not_san ?? data.hives_count) !== undefined && (data.so_luong_not_san ?? data.hives_count) !== null
          ? Math.max(0, parseInt(data.so_luong_not_san ?? data.hives_count, 10))
          : null,
        data.url_anh || data.url || data.image_url || tepRes.rows[0].duong_dan_url || null,
      ]
    );

    const row = res.rows[0];
    return {
      ...row,
      ma_anh: Number(row.ma_anh),
      ma_tep_dinh_kem: Number(row.ma_tep_dinh_kem),
      ma_dot_ton_thuong_da: row.ma_dot_ton_thuong_da ? Number(row.ma_dot_ton_thuong_da) : null,
      ma_vi_tri_ton_thuong: row.ma_vi_tri_ton_thuong ? Number(row.ma_vi_tri_ton_thuong) : null,
    };
  }

  async updateLesionPhotoMilestone(user, photoId, data = {}) {
    const pid = parseInt(photoId, 10);
    const chk = await db.query(
      `SELECT a.*, d.ma_benh_nhan AS dot_benh_nhan, hs.ma_benh_nhan AS hoso_benh_nhan
       FROM public.anhchuptonthuong a
       JOIN public.tepdinhkem t ON a.ma_tep_dinh_kem = t.ma_tep_dinh_kem
       LEFT JOIN public.dottonthuongda d ON a.ma_dot_ton_thuong_da = d.ma_dot_ton_thuong_da
       LEFT JOIN public.hosobenhan hs ON t.ma_ho_so = hs.ma_ho_so
       WHERE a.ma_anh = $1 LIMIT 1`,
      [pid]
    );
    if (!chk.rows[0]) throw createAppError(`Không tìm thấy ảnh tổn thương #${pid}`, 3007, 404);
    const ownerPid = chk.rows[0].hoso_benh_nhan || chk.rows[0].dot_benh_nhan;
    if (ownerPid) await patientService.assertPatientAccess(user, ownerPid);

    const clamp010 = (v) => (v === undefined || v === null ? null : Math.min(10, Math.max(0, parseInt(v, 10) || 0)));
    const sets = [];
    const params = [];
    const addSet = (col, val) => {
      params.push(val);
      sets.push(`${col} = $${params.length}`);
    };

    const milestone = data.moc_tien_trien ?? data.milestone;
    if (milestone !== undefined) addSet('moc_tien_trien', milestone);
    const itch = data.diem_ngua_nrs ?? data.itch_score_nrs ?? data.itch_score;
    if (itch !== undefined) addSet('diem_ngua_nrs', clamp010(itch));
    const pain = data.diem_dau_nrs ?? data.pain_score_nrs ?? data.pain_score;
    if (pain !== undefined) addSet('diem_dau_nrs', clamp010(pain));
    const burn = data.diem_bong_rat_nrs ?? data.burning_score_nrs ?? data.burn_score;
    if (burn !== undefined) addSet('diem_bong_rat_nrs', clamp010(burn));
    const hives = data.so_luong_not_san ?? data.hives_count;
    if (hives !== undefined) addSet('so_luong_not_san', hives === null ? null : Math.max(0, parseInt(hives, 10)));

    if (sets.length === 0) return { ...chk.rows[0], ma_anh: Number(chk.rows[0].ma_anh) };
    params.push(pid);
    const upd = await db.query(
      `UPDATE public.anhchuptonthuong SET ${sets.join(', ')}, thoi_diem_cap_nhat = CURRENT_TIMESTAMP WHERE ma_anh = $${params.length} RETURNING *`,
      params
    );
    const row = upd.rows[0];
    return {
      ...row,
      ma_anh: Number(row.ma_anh),
      ma_tep_dinh_kem: Number(row.ma_tep_dinh_kem),
      ma_dot_ton_thuong_da: row.ma_dot_ton_thuong_da ? Number(row.ma_dot_ton_thuong_da) : null,
      ma_vi_tri_ton_thuong: row.ma_vi_tri_ton_thuong ? Number(row.ma_vi_tri_ton_thuong) : null,
    };
  }

  async getLesionPhotos(user, queryParams = {}) {
    const eid = queryParams.episode_id || queryParams.ma_dot_ton_thuong_da;
    const lid = queryParams.location_id || queryParams.ma_vi_tri_ton_thuong;
    const rid = queryParams.medical_record_id || queryParams.ma_ho_so;

    const conditions = [];
    const params = [];

    if (eid) {
      params.push(parseInt(eid, 10));
      conditions.push(`a.ma_dot_ton_thuong_da = $${params.length}`);
    }
    if (lid) {
      params.push(parseInt(lid, 10));
      conditions.push(`a.ma_vi_tri_ton_thuong = $${params.length}`);
    }
    if (rid) {
      await this._getRecordOrThrow(rid, user);
      params.push(parseInt(rid, 10));
      conditions.push(`t.ma_ho_so = $${params.length}`);
    } else if (!isStaffRole(user)) {
      const pid = await resolvePatientIdForUser(db, user);
      if (!pid) return [];
      params.push(pid);
      conditions.push(`(d.ma_benh_nhan = $${params.length} OR hs.ma_benh_nhan = $${params.length})`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const res = await db.query(
      `SELECT a.*, t.ma_ho_so, t.duong_dan_url, t.ten_tep_goc
       FROM public.anhchuptonthuong a
       JOIN public.tepdinhkem t ON a.ma_tep_dinh_kem = t.ma_tep_dinh_kem
       LEFT JOIN public.dottonthuongda d ON a.ma_dot_ton_thuong_da = d.ma_dot_ton_thuong_da
       LEFT JOIN public.hosobenhan hs ON t.ma_ho_so = hs.ma_ho_so
       ${where}
       ORDER BY a.ma_anh DESC
       LIMIT 100`,
      params
    );
    return res.rows.map((r) => ({
      ...r,
      ma_anh: Number(r.ma_anh),
      ma_tep_dinh_kem: Number(r.ma_tep_dinh_kem),
      ma_ho_so: Number(r.ma_ho_so),
    }));
  }

  async deleteLesionPhoto(user, photoId) {
    const pid = parseInt(photoId, 10);
    const chk = await db.query(
      `SELECT a.*, t.ma_tai_khoan, hs.ma_benh_nhan
       FROM public.anhchuptonthuong a
       JOIN public.tepdinhkem t ON a.ma_tep_dinh_kem = t.ma_tep_dinh_kem
       JOIN public.hosobenhan hs ON t.ma_ho_so = hs.ma_ho_so
       WHERE a.ma_anh = $1 LIMIT 1`,
      [pid]
    );
    if (!chk.rows[0]) throw createAppError(`Không tìm thấy ảnh tổn thương #${pid}`, 3007, 404);
    await patientService.assertPatientAccess(user, chk.rows[0].ma_benh_nhan);
    await db.query('DELETE FROM public.anhchuptonthuong WHERE ma_anh = $1', [pid]);
    return { ma_anh: pid, deleted: true };
  }

  // Answer Images (Sub DB)
  async attachAnswerImage(user, data = {}) {
    let rid = data.medical_record_id || data.ma_ho_so ? parseInt(data.medical_record_id || data.ma_ho_so, 10) : NaN;
    let qid = data.question_id ? parseInt(data.question_id, 10) : NaN;
    const answerId = data.answer_id ? parseInt(data.answer_id, 10) : NaN;

    if (!Number.isNaN(answerId) && (Number.isNaN(rid) || Number.isNaN(qid))) {
      const ans = await prisma.medicalRecordAnswer.findUnique({ where: { id: answerId } });
      if (!ans) throw createAppError(`Không tìm thấy câu trả lời #${answerId}`, 3007, 404);
      rid = Number(ans.maHoSo);
      qid = ans.questionId;
    }

    if (Number.isNaN(rid) || Number.isNaN(qid)) {
      throw createAppError('Thiếu medical_record_id + question_id hoặc answer_id', 2001, 400);
    }
    await this._getRecordOrThrow(rid, user);

    let aid = data.attachment_id || data.ma_tep_dinh_kem ? parseInt(data.attachment_id || data.ma_tep_dinh_kem, 10) : NaN;
    let publicUrl = data.public_url || data.image_url || data.url || null;

    if (Number.isNaN(aid) && publicUrl) {
      const tepIns = await db.query(
        `INSERT INTO public.tepdinhkem (ma_ho_so, ma_tai_khoan, ten_tep_goc, duong_dan_luu_tru, duong_dan_url, dinh_dang_tep, dung_luong_byte)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ma_tep_dinh_kem`,
        [rid, user.ma_tai_khoan, data.file_name || 'answer-image.jpg', publicUrl, publicUrl, 'image/jpeg', 1024]
      );
      aid = Number(tepIns.rows[0].ma_tep_dinh_kem);
    }

    if (Number.isNaN(aid)) {
      throw createAppError('Thiếu attachment_id (ma_tep_dinh_kem) hoặc image_url', 2001, 400);
    }

    if (!publicUrl) {
      const tep = await db.query('SELECT duong_dan_url FROM public.tepdinhkem WHERE ma_tep_dinh_kem = $1 LIMIT 1', [aid]);
      publicUrl = tep.rows[0]?.duong_dan_url || null;
    }

    const created = await prisma.answerImage.upsert({
      where: { maHoSo_questionId_attachmentId: { maHoSo: BigInt(rid), questionId: qid, attachmentId: BigInt(aid) } },
      create: { maHoSo: BigInt(rid), questionId: qid, attachmentId: BigInt(aid), publicUrl },
      update: { publicUrl },
    });
    return {
      id: created.id,
      answer_id: !Number.isNaN(answerId) ? answerId : null,
      ma_ho_so: Number(created.maHoSo),
      question_id: created.questionId,
      attachment_id: Number(created.attachmentId),
      public_url: created.publicUrl,
      option_value: data.option_value || null,
    };
  }

  async getAnswerImages(user, queryParams = {}) {
    let rid = queryParams.medical_record_id || queryParams.ma_ho_so ? parseInt(queryParams.medical_record_id || queryParams.ma_ho_so, 10) : NaN;
    let qid = queryParams.question_id ? parseInt(queryParams.question_id, 10) : NaN;
    const answerId = queryParams.answer_id ? parseInt(queryParams.answer_id, 10) : NaN;

    if (!Number.isNaN(answerId)) {
      const ans = await prisma.medicalRecordAnswer.findUnique({ where: { id: answerId } });
      if (!ans) throw createAppError(`Không tìm thấy câu trả lời #${answerId}`, 3007, 404);
      rid = Number(ans.maHoSo);
      qid = ans.questionId;
    }

    if (Number.isNaN(rid)) throw createAppError('Thiếu medical_record_id hoặc answer_id', 2001, 400);
    await this._getRecordOrThrow(rid, user);

    const where = { maHoSo: BigInt(rid) };
    if (!Number.isNaN(qid)) where.questionId = qid;
    const rows = await prisma.answerImage.findMany({ where, orderBy: { id: 'desc' } });
    return rows.map((r) => ({
      id: r.id,
      answer_id: !Number.isNaN(answerId) ? answerId : null,
      ma_ho_so: Number(r.maHoSo),
      question_id: r.questionId,
      attachment_id: Number(r.attachmentId),
      public_url: r.publicUrl,
    }));
  }

  async deleteAnswerImage(user, answerImageId) {
    const id = parseInt(answerImageId, 10);
    const existing = await prisma.answerImage.findUnique({ where: { id } });
    if (!existing) throw createAppError(`Không tìm thấy liên kết ảnh #${id}`, 3007, 404);
    await this._getRecordOrThrow(Number(existing.maHoSo), user);
    await prisma.answerImage.delete({ where: { id } });
    return { id, deleted: true };
  }
}

module.exports = new PatientFlowService();

