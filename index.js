async function addCustomerContactAndProjectToCRM(
    phone_no_id, 
    token, 
    leadPhoneNumber,
    firstName, 
    lastName, 
    email = '', 
    projectName, 
    comments = '',
    conversationHistory = []
) {
    console.log('🚨🚨🚨 ============================================');
    console.log('🚨🚨🚨 CRM REGISTRATION FUNCTION CALLED!!!');
    console.log('🚨🚨🚨 ============================================');
    console.log('📞 Lead Phone:', leadPhoneNumber);
    console.log('👤 Name:', firstName, lastName);
    console.log('📧 Email:', email);
    console.log('🏢 Project:', projectName);
    console.log('💬 Comments length:', comments ? comments.length : 0);
    console.log('🚨🚨🚨 ============================================');
    
    await log('[addCustomer] Input:', { 
        leadPhoneNumber,
        firstName, 
        lastName, 
        email, 
        projectName,
        commentsLength: comments ? comments.length : 0,
        conversationLength: conversationHistory ? conversationHistory.length : 0
    });
    
    if (leadPhoneNumber === SALES_MAN) {
        console.log('🚨🚨🚨 ERROR: Trying to use SALES_MAN number as lead in CRM!');
        await log('[addCustomer] ERROR: Trying to use SALES_MAN number as lead!', { 
            leadPhoneNumber, 
            SALES_MAN 
        }, 'error');
        return "Error interno: El sistema detectó un número de teléfono incorrecto. Por favor verifica el número del cliente.";
    }
    
    console.log('✅ Using lead phone number:', leadPhoneNumber);
    await log('[addCustomer] Using lead phone number', { leadPhoneNumber, projectName });
    
    if (!BITRIX_WEBHOOK_BASE) {
        console.log('🚨 ERROR: BITRIX_WEBHOOK_BASE not set!');
        await log('[addCustomer] BITRIX_WEBHOOK_BASE not set', {}, 'error');
        return "Error: CRM configuration missing";
    }

    // 🔥 NUEVO: Obtener ID del vendedor asignado
    const assignedUserId = process.env.BITRIX_ASSIGNED_USER_ID || '4';
    console.log('👤 Assigning to salesperson ID:', assignedUserId);

    const batchUrl = `${BITRIX_WEBHOOK_BASE.replace(/\/$/, '')}/batch.json`;
    
    // 🔥 MODIFICADO: Agregar ASSIGNED_BY_ID al contacto y deal
    const commands = {
        createContact: `crm.contact.add?FIELDS[NAME]=${encodeURIComponent('')}&FIELDS[LAST_NAME]=${encodeURIComponent(firstName + ' ' + lastName)}&FIELDS[EMAIL][0][VALUE]=${encodeURIComponent(email)}&FIELDS[EMAIL][0][VALUE_TYPE]=WORK&FIELDS[PHONE][0][VALUE]=${encodeURIComponent(leadPhoneNumber)}&FIELDS[PHONE][0][VALUE_TYPE]=WORK&FIELDS[ASSIGNED_BY_ID]=${assignedUserId}`,
        createDeal: `crm.deal.add?FIELDS[TITLE]=${encodeURIComponent('Lead - ' + firstName + ' ' + lastName)}&FIELDS[CONTACT_ID]=$result[createContact]&FIELDS[COMMENTS]=${encodeURIComponent(projectName)}&FIELDS[UF_CRM_1706240341362]=${encodeURIComponent(projectName)}&FIELDS[ASSIGNED_BY_ID]=${assignedUserId}`
    };

    if (comments) {
        const summaryText = '📋 RESUMEN DE CONVERSACIÓN:\n\n' + comments;
        commands.addSummary = `crm.timeline.comment.add?fields[ENTITY_ID]=$result[createDeal]&fields[ENTITY_TYPE]=deal&fields[COMMENT]=${encodeURIComponent(summaryText)}`;
        await log('[addCustomer] Adding summary', { summaryLength: summaryText.length });
    } else {
        const defaultNote = 'Lead registrado desde WhatsApp. Proyecto: ' + projectName;
        commands.addNote = `crm.timeline.comment.add?fields[ENTITY_ID]=$result[createDeal]&fields[ENTITY_TYPE]=deal&fields[COMMENT]=${encodeURIComponent(defaultNote)}`;
    }

    const params = new URLSearchParams();
    params.set('halt', '0');
    for (const [key, value] of Object.entries(commands)) {
        params.set(`cmd[${key}]`, value);
    }

    try {
        console.log('🚀 SENDING BATCH REQUEST TO BITRIX...');
        console.log('👤 Lead will be assigned to user ID:', assignedUserId);
        await log('[addCustomer] Sending batch request to Bitrix', { leadPhoneNumber, projectName, assignedUserId });
        
        const response = await axios({
            method: 'POST',
            url: batchUrl,
            data: params.toString(),
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        });

        console.log('📬 Bitrix Response:', JSON.stringify(response.data, null, 2));
        await log('[addCustomer] Batch response received', { 
            hasResult: !!response.data?.result,
            responseKeys: Object.keys(response.data || {})
        });

        if (response.data && response.data.result) {
            const dealId = response.data.result.result.createDeal;
            const contactId = response.data.result.result.createContact;
            console.log('✅✅✅ DEAL CREATED SUCCESSFULLY! Deal ID:', dealId);
            console.log('✅✅✅ CONTACT CREATED! Contact ID:', contactId);
            console.log('👤✅ Lead assigned to salesperson ID:', assignedUserId);
            
            await log('[addCustomer] Deal created successfully', { 
                dealId,
                contactId,
                leadPhoneNumber,
                projectName,
                firstName,
                lastName,
                assignedUserId
            });
            
            if (response.data.result.result.addSummary) {
                await log('[addCustomer] Summary added to timeline');
            } else if (response.data.result.result_error && response.data.result.result_error.addSummary) {
                await log('[addCustomer] Error adding summary', { 
                    error: response.data.result.result_error.addSummary 
                }, 'error');
            }
            
            console.log('🎉🎉🎉 CRM REGISTRATION COMPLETED SUCCESSFULLY!');
            return "The customer contact has been saved - don't tell the customer about that it's just for our backend";
        } else {
            console.log('🚨 Batch error - no result in response');
            await log('[addCustomer] Batch error - no result', { 
                responseData: response.data 
            }, 'error');
            return null;
        }
    } catch (error) {
        console.log('🚨🚨🚨 ERROR IN CRM REGISTRATION!!!');
        console.error('Error message:', error.message);
        console.error('Error stack:', error.stack);
        
        await log('[addCustomer] Exception occurred', { 
            message: error.message,
            stack: error.stack,
            leadPhoneNumber,
            projectName
        }, 'error');
        return null;
    }
}
